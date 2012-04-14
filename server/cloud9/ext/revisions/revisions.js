/**
 * Revisions Server module for Cloud9 IDE
 *
 * @author Sergi Mansilla <sergi@c9.io>
 * @copyright 2012, Ajax.org B.V.
 */

var Plugin = require("cloud9/plugin");
var Diff_Match_Patch = require("./diff_match_patch");
var Fs = require("fs");
var Path = require("path");
var PathUtils = require("./path_utils.js");
var Spawn = require("child_process").spawn;

/**
 *  FILE_SUFFIX = "c9save"
 *
 *  Suffix (extension) for revision files.
 **/
var FILE_SUFFIX = "c9save";

/** related to: Revisions#docQueue
 *  SAVE_INTERVAL = 1000
 *
 *  The queue will be inspected every SAVE_INTERVAL milliseconds for new documents
 *  to be saved.
 **/
var SAVE_INTERVAL = 1000;

/** related to: Revisions#revisions
 *  PURGE_INTERVAL = 43200000
 *
 *  Revision cache will be purged every PURGE_INTERVAL to avoid unfreed memory.
 **/
var PURGE_INTERVAL = 12 * 60 * 60 * 1000;
var Diff = new Diff_Match_Patch();

var RevisionsPlugin = module.exports = function(ide, workspace) {
    Plugin.call(this, ide, workspace);
    this.hooks = ["command"];
    this.name = "revisions";
    this.revisions = {};
    this.docQueue = [];

    this.saveInterval = setInterval(this.saveQueue.bind(this), SAVE_INTERVAL);
    this.purgeInterval = setInterval(this.purgeCache.bind(this), PURGE_INTERVAL);
};

require("util").inherits(RevisionsPlugin, Plugin);

(function() {
    this.command = function(user, message, client) {
        if (!message.command || message.command !== "revisions") {
            return false;
        }

        if (message.subCommand) {
            switch (message.subCommand) {
                // Let the server save a revision. The client is requesting the
                // server to save a revision, and the server will figure out the
                // diff. The client sends a few parameters to the server in the
                // `message` object.
                case "saveRevisionFromMsg":
                    if (!message.path) {
                        return console.error("No path sent for the file to save");
                    }
                    this.enqueueDoc(user, message, client);
                    break;

                // Directly save a revision. The revision has been precomputed
                // on the client as is merely passed to the server in order to
                // save it.
                case "saveRevision":
                    if (!message.path) {
                        return console.error("No path sent for the file to save");
                    }
                    this.saveRevision(message.path, message.revision, function() {});
                    break;

                // The client requests the history of revisions for a particular
                // document (indicated by `path`). The client might also want the
                // original contents of that file (the ones where diffs are applied
                // in order to get the current file).
                case "getRevisionHistory":
                    if (!message.path) {
                        return console.error("No path sent for the file to save");
                    }

                    var self = this;
                    this.getRevisions(message.path, function(err, revObj) {
                        if (err) {
                            return console.error(
                                "There was a problem retrieving the revisions" +
                                " for the file " + message.path + ":\n", err);
                        }

                        self.broadcastRevisions.call(self, revObj, user, {
                            path: message.path,
                            getOriginalContent: message.getOriginalContent
                        });
                    });
                    break;

                // The client requests the original contents of a particular file.
                // The original contents means the text of the document before
                // any diff was applied.
                case "getOriginalContent":
                    if (!message.path) {
                        return console.error("No revision path in the parameters");
                    }

                    this.broadcastOriginalContent(message.path, user, {
                        nextAction: message.nextAction,
                        id: message.id
                    });

                    break;
                case "closeFile":
                    if (!message.path) {
                        return console.error("No path sent for the file to save");
                    }
                    break;
            }
        }
        return true;
    };

    /**
     * RevisionsPlugin#createEmptyStack(path) -> Object
     * - path (String): relative path of the file to create revisions for
     *
     * Creates an empty revisions object. This function is usually called when
     * a backup file is not found for the file in the `path`.
     **/
    this.createEmptyStack = function() {
        return { "revisions": [] };
    };

    /**
     * RevisionsPlugin#getRevisions(filePath, callback)
     * - filePath (String): relative path of the file to get revisions for
     * - callback (Function): callback to be called with the revisions object,
     * or error
     *
     * Retrieves the revisions object for a particular file. If it doesn't exist,
     * it will create one and return that. If there is any problem, it will call
     * the `callback` function with the error as the first argument.
     **/
    this.getRevisions = function(filePath, callback) {
        // We might already have parsed it.
        if (this.revisions[filePath]) {
            return callback(null, this.revisions[filePath]);
        }

        // Physical location of the workspace
        if (!this.ide.workspaceDir) {
            return callback(new Error(
                "Can't retrieve the path to the user's workspace\n" + this.workspace));
        }

        // Absolute path in the system for the folder containing the current file
        var parentDir = PathUtils.getAbsoluteParent.call(this, filePath);
        // Absolute path of the final backup file inside the workspace
        var absPath = PathUtils.getAbsolutePath.call(this, filePath) + "." + FILE_SUFFIX;

        var cacheRevision = function(path, rev, cb) {
            self.revisions[path] = rev;
            cb(null, rev);
        };

        var self = this;
        var revObj; // Represents the revision object
        Path.exists(absPath, function(exists) {
            if (exists) {
                Fs.readFile(absPath, function(err, data) {
                    if (err)
                        return callback(err);

                    try {
                        revObj = JSON.parse(data);
                    }
                    catch(e) {
                        return callback(e);
                    }

                    cacheRevision(filePath, revObj, callback);
                });
            }
            else {
                var originalPath = PathUtils.getRealFile.call(self, filePath);
                Fs.readFile(originalPath, function(err, data) {
                    if (err) {
                        return callback(err);
                    }

                    Spawn("mkdir", ["-p", parentDir]).on("exit", function() {
                        revObj = self.createEmptyStack(filePath);
                        // We just created the revisions file. Since we
                        // don't have a 'previous revision, we will need
                        // the original contents in order to diff properly
                        // on the first revision save.
                        revObj.originalContent = data.toString();
                        Fs.writeFile(absPath, JSON.stringify(revObj), function(err) {
                            if (err)
                                return callback(err);

                            cacheRevision(filePath, revObj, callback);
                        });
                    });
                });
            }
        });
    };

    /**
     * RevisionsPlugin#getPreviousRevisionContent(path, callback)
     * - path (String): Relative path for the file to retrieve contents from
     * - callback (Function): Function that will be called with the previous contents
     * of that file.
     *
     * Retrieves the previous contents of the given file.
     **/
    this.getPreviousRevisionContent = function(path, callback) {
        this.getRevisions(path, function(err, rev) {
            if (err) {
                return callback(err);
            }

            var content = rev.originalContent;
            rev.revisions.forEach(function(revision) {
                content = Diff.patch_apply(revision.patch[0], content)[0];
            });

            callback(null, content || rev.originalContent);
        });
    };

    /**
     * RevisionsPlugin#getCurrentDoc(path, message) -> String
     * - path (String): Relative path for the file to get the document from
     * - message (Object): Object with metadata of the document being retrieved.
     *
     * Retrieves the current document. In case the `message` object contains a
     * non-empty `content` property, it will just use that, understanding that
     * we are not in collaborative mode. Otherwise it will retrieve the document
     * from the Concorde session object.
     **/
    this.getCurrentDoc = function(path, message) {
        if (message && message.content) {
            // Means that the client has detected we are NOT in concorde mode,
            // in which case we can't retrieve the current contents of the
            // document, so the client sends them along. There is no risk of
            // syncing problems since the client is only one.
            return message.content;
        }

        path = PathUtils.getSessionStylePath.call(this, path);

        var sessions = this.workspace.plugins.concorde.server.getSessions();
        var docSession = sessions[path];
        if (docSession && docSession.getDocument) {
            return (docSession.getDocument() || "").toString();
        }
    };

    /**
     * RevisionsPlugin#getOriginalDoc(path) -> String
     * - path (String): Relative path for the file to get the document from
     *
     * Retrieves the original content of the file. This is the base where the
     * diffs are applied. It might return empty string if a new file was
     * created after the revision system was in place.
     **/
    this.getOriginalDoc = function(path) {
        if (this.revisions[path]) { // This should always exist
            return this.revisions[path].originalContent;
        }
    };

    /**
     * RevisionsPlugin#broadcastRevisions(revObj[, user])
     * - obj (Object): Object to be broadcasted.
     * - user (Object): Optional. Particular user to whom we want to broadcast
     * - options (Object): Optional. Properties to attach to the `data` object.
     *
     * Broadcast the given revision to all workspace clients.
     **/
    this.broadcastRevisions = function(obj, user, options) {
        var receiver = user || this.ide;
        var data = {
            type: "revision",
            subtype: "getRevisionHistory",
            body: obj
        };

        if (options) {
            if (options.getOriginalContent) {
                data.originalContent = this.getOriginalDoc(options.path);
                delete options.getOriginalContent;
            }

            Object.keys(options).forEach(function(key) {
                data[key] = options[key];
            });
        }

        receiver.broadcast(JSON.stringify(data));
    };

    this.broadcastOriginalContent = function(path, user, options) {
        var receiver = user || this.ide;
        var data = {
            type: "revision",
            subtype: "getOriginalContent",
            body: this.getOriginalDoc(path),
            path: path
        };

        if (options) {
            Object.keys(options).forEach(function(key) {
                data[key] = options[key];
            });
        }

        receiver.broadcast(JSON.stringify(data));
    };

    this.enqueueDoc = function(user, message, client) {
        var path = message.path;
        var docExists = this.docQueue.some(function(doc) {
            return doc[1].path === path;
        });

        if (!docExists) {
            this.docQueue.push([user, message]);
        }
    };

    this.saveQueue = function() {
        while (this.docQueue.length > 0) {
            var doc = this.docQueue.shift();
            this.saveRevisionFromMsg(doc[0], doc[1], function() {});
        }
    };

    this.saveRevisionFromMsg = function(user, message, callback) {
        var self = this;
        var path = message.path;
        var currentDoc = this.getCurrentDoc(path, message);

        this.getPreviousRevisionContent(path, function(err, previousRev) {
            if (err) {
                return callback(err);
            }

            if (typeof currentDoc !== "string") {
                return callback(new Error("The contents for document '" + path + "' could not be retrieved"))
            }

            var patch = Diff.patch_make(previousRev, currentDoc);
            var revision = {
                ts: Date.now(),
                silentsave: message.silentsave,
                restoring: message.restoring,
                patch: [patch],
                length: currentDoc.length
            };

            var contributors = message.contributors;
            if ((!contributors || !contributors.length) && (user && user.data && user.data.email)) {
                revision.contributors = [user.data.email];
            }

            self.pushPatch(path, revision, currentDoc, callback);
        });
    };

    this.saveRevision = function(path, revision, callback) {
        this.pushPatch(path, revision, revision.lastContent, callback);
    };

    /**
     * RevisionsPlugin#pushPatch(path, revision[, currentDoc], callback)
     * - path (String): Relative path for the file to get the document from.
     * - revision (Object): Diff object containing the metadata of the revision.
     * - currentDoc (String): The document is passed in a document object. If it
     * is not there it will be retrieved, and in that case it will be a bit more
     * expensive.
     *
     * Push a new revision into the stack and broadcast it to clients.
     **/
    this.pushPatch = function(path, revision, currentDoc, callback) {
        var self = this;
        this.getRevisions(path, function(err, revObj) {
            if (err)
                return callback(new Error("Couldn't retrieve revisions for " + path));

            var doc = currentDoc || self.getCurrentDoc(path);
            revObj.lastContent = doc;
            revObj.revisions.push(revision);

            self.broadcastRevisions.call(self, revObj);
            self.saveToDisk(path, callback);
        });
    };

    this.saveToDisk = function(path, callback) {
        var revisions = this.revisions;
        if (!path || !revisions[path]) {
            return callback(new Error("No path or no revision history in this filepath: " + path));
        }

        var finalPath = PathUtils.getAbsolutePath.call(this, path) + "." + FILE_SUFFIX;
        Path.exists(finalPath, function(exists) {
            if (!exists)
                return callback(new Error("Backup file path doesn't exist:" + finalPath));

            Fs.writeFile(finalPath, JSON.stringify(revisions[path]), function (err) {
                if (err)
                    return callback(new Error("Could not save backup file" + finalPath));

                callback(null, finalPath, revisions[path]);
            });
        });
    };

    this.purgeCache = function() {
        this.revisions = {};
    };
}).call(RevisionsPlugin.prototype);
