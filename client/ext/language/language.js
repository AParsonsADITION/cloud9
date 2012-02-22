/**
 * Cloud9 Language Foundation
 *
 * @copyright 2011, Ajax.org B.V.
 * @license GPLv3 <http://www.gnu.org/licenses/gpl.txt>
 */
define(function(require, exports, module) {

var ext = require("core/ext");
var ide = require("core/ide");
var editors = require("ext/editors/editors");
var noderunner = require("ext/noderunner/noderunner");
var WorkerClient = require("ace/worker/worker_client").WorkerClient;
var save = require("ext/save/save");

var complete = require('ext/language/complete');
var marker = require('ext/language/marker');
var refactor = require('ext/language/refactor');
var outline = require('ext/language/outline');
var format = require('ext/language/format');
var liveInspect = require('ext/language/liveinspect');

var markup = require("text!ext/language/language.xml");
var skin = require("text!ext/language/skin.xml");
var css = require("text!ext/language/language.css");
var lang = require("ace/lib/lang");
var keyhandler = require("ext/language/keyhandler");

var settings = require("text!ext/language/settings.xml");
var extSettings = require("ext/settings/settings");


module.exports = ext.register("ext/language/language", {
    name    : "Javascript Outline",
    dev     : "Ajax.org",
    type    : ext.GENERAL,
    deps    : [editors, noderunner],
    nodes   : [],
    alone   : true,
    markup  : markup,
    skin    : skin,
    worker  : null,
    enabled : true,
    commands : {
        "complete": {hint: "code complete"},
        "renameVar": {hint: "Rename variable"}
    },
    hotitems: {},
    
    defaultKeyHandler: null,
    enableContinuousCompletion: false,

    hook : function() {
		var _self = this;
        
        var deferred = lang.deferredCall(function() {
            _self.setPath();
        });
        
        var worker = this.worker = new WorkerClient(["treehugger", "ext", "ace", "c9"], null, "ext/language/worker", "LanguageWorker");
        complete.setWorker(worker);
        
        //ide.addEventListener("init.ext/code/code", function(){
		ide.addEventListener("afteropenfile", function(event){
            if (!event.node)
                return;
            if (!editors.currentEditor || !editors.currentEditor.ceEditor) // No editor, for some reason
                return;
            ext.initExtension(_self);
            var path = event.node.getAttribute("path");
            var editor = editors.currentEditor.ceEditor.$editor;
            worker.call("switchFile", [path, editor.syntax, event.doc.getValue(), window.cloud9config.projectName]);
            event.doc.addEventListener("close", function() {
                worker.emit("documentClose", {data: path});
            });
            
            // This is necessary to know which file was opened last, for some reason the afteropenfile events happen out of sequence
            deferred.cancel().schedule(100);
	    });
        
        
        // Language features
        marker.hook(this, worker);
        complete.hook(8, worker);
        refactor.hook(this, worker);
        outline.hook(this, worker);
        format.hook(this, worker);
        
        ide.dispatchEvent("language.worker", {worker: worker});
        ide.addEventListener("$event.language.worker", function(callback){
            callback({worker: worker});
        });
        
        ide.addEventListener("init.ext/settings/settings", function (e) {
            var heading = e.ext.getHeading("Language Support");
            heading.insertMarkup(settings);
        });
        
        worker.on("serverProxy", function(e) {
            console.log("proxyMessage", e.data);
            ide.send(JSON.stringify(e.data));
        });
        
        worker.on("commandRequest", function(e) {
            var cmd = e.data;
            if (cmd.command == "save") {
              save.quicksave(tabEditors.getPage(), function() {
                worker.emit("commandComplete", {
                 data: {
                  command: cmd.command,
                  success: true
                }});
              });
            }
        });
        
        ide.addEventListener("socketMessage", function(e) {
          var message = e.message;
          console.log("language: ", message);
          worker.emit("serverProxy", {data: message});
        });
	},

    init : function() {
        var _self = this;
        var worker = this.worker;
        apf.importCssString(css);
        if (!editors.currentEditor || !editors.currentEditor.ceEditor)
            return;
        this.editor = editors.currentEditor.ceEditor.$editor;
        this.$onCursorChange = this.onCursorChangeDefer.bind(this);
        this.editor.selection.on("changeCursor", this.$onCursorChange);
        var oldSelection = this.editor.selection;
        this.setPath();
        
        if(this.enableContinuousCompletion) {
            var defaultOnTextInput = this.editor.keyBinding.onTextInput.bind(this.editor.keyBinding);
            this.editor.keyBinding.onTextInput = keyhandler.composeHandlers(keyhandler.typeAlongCompleteTextInput, defaultOnTextInput);
        }
        
        this.updateSettings();
    
        this.editor.on("changeSession", function() {
            // Time out a litle, to let the page path be updated
            setTimeout(function() {
                _self.setPath();
                oldSelection.removeEventListener("changeCursor", _self.$onCursorChange);
                _self.editor.selection.on("changeCursor", _self.$onCursorChange);
                oldSelection = _self.editor.selection;
            }, 100);
        });

        this.editor.addEventListener("change", function(e) {
            e.range = {
                start: e.data.range.start,
                end: e.data.range.end
            };
            worker.emit("change", e);
            marker.onChange(_self.editor.session, e);
        });
        
        ide.addEventListener("liveinspect", function (e) {
            worker.emit("inspect", { data: { row: e.row, col: e.col } });
        });
        
        extSettings.model.addEventListener("update", this.updateSettings.bind(this));
        
        this.editor.addEventListener("mousedown", this.onEditorClick.bind(this));
    },
    
    updateSettings: function() {
        // Currently no code editor active
        if(!editors.currentEditor.ceEditor || !tabEditors.getPage())
            return;
        if(extSettings.model.queryValue("language/@jshint") != "false")
            this.worker.call("enableFeature", ["jshint"]);
        else
            this.worker.call("disableFeature", ["jshint"]);
        if(extSettings.model.queryValue("language/@instanceHighlight") != "false")
            this.worker.call("enableFeature", ["instanceHighlight"]);
        else
            this.worker.call("disableFeature", ["instanceHighlight"]);
        if(extSettings.model.queryValue("language/@unusedFunctionArgs") != "false")
            this.worker.call("enableFeature", ["unusedFunctionArgs"]);
        else
            this.worker.call("disableFeature", ["unusedFunctionArgs"]);
        if(extSettings.model.queryValue("language/@undeclaredVars") != "false")
            this.worker.call("enableFeature", ["undeclaredVars"]);
        else
            this.worker.call("disableFeature", ["undeclaredVars"]);
        this.worker.call("setWarningLevel", [extSettings.model.queryValue("language/@warnLevel") || "info"]);
        var cursorPos = this.editor.getCursorPosition();
        cursorPos.force = true;
        this.worker.emit("cursormove", {data: cursorPos});
        this.setPath();
    },
    
    setPath: function() {
        // Currently no code editor active
        if(!editors.currentEditor.ceEditor || !tabEditors.getPage())
            return;
        var currentPath = tabEditors.getPage().getAttribute("id");
        this.worker.call("switchFile", [currentPath, editors.currentEditor.ceEditor.syntax, this.editor.getSession().getValue(), window.cloud9config.projectName]);
    },
    
    onEditorClick: function(event) {
        if(event.domEvent.altKey) {
            var pos = event.getDocumentPosition();
            this.worker.emit("jumpToDefinition", {data: pos});
        }
    },
    
    /**
     * Method attached to key combo for complete
     */
    complete: function() {
        complete.invoke();
    },
    
    registerLanguageHandler: function(modulePath, className) {
        this.worker.call("register", [modulePath, className]);
    },
    
    onCursorChangeDefer: function() {
        if(!this.onCursorChangeDeferred) {
            this.onCursorChangeDeferred = lang.deferredCall(this.onCursorChange.bind(this));
        }
        this.onCursorChangeDeferred.cancel().schedule(250);
    },
    
    onCursorChange: function() {
        this.worker.emit("cursormove", {data: this.editor.getCursorPosition()});
    },

    enable : function() {
    },

    disable : function() {
    },

    destroy : function() {
    }
});

});
