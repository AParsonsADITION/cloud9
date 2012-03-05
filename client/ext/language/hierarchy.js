/**
 * Module that implements hierarchys
 */
define(function(require, exports, module) {

var editors = require("ext/editors/editors");
var Range = require("ace/range").Range;
var ide = require("core/ide");

module.exports = {
    hook: function(ext, worker) {
        var _self = this;
        
        worker.on("hierarchy", function(event) {
            _self.cachedEvent = event;
            _self.renderHierarchy(event, 0);
        });

        function triggerHierarchy() {
            var editor = editors.currentEditor.ceEditor.$editor;
            worker.emit("hierarchy", {data: {pos: editor.getCursorPosition()}});
        }

        var hierarchyItem = new apf.item({
            caption: "Hierarchy",
            onclick: triggerHierarchy
        });
        ext.nodes.push(ide.mnuEdit.appendChild(hierarchyItem));
        
        var hierarchyContextItem = new apf.item({
            caption: "Open Type Hierarchy",
            onclick: triggerHierarchy
        });
        var contextItemAdded = false;

        function fileChange() {
            // Currently no code editor active
            if(!editors.currentEditor || !editors.currentEditor.ceEditor || !tabEditors.getPage())
                return;
            var currentPath = tabEditors.getPage().getAttribute("id");
            if (! contextItemAdded) {
                ext.nodes.push(mnuCtxEditor.appendChild(hierarchyContextItem));
                contextItemAdded = true;
            }
        }

        var checkEditorInterval = setInterval(function() {
            if (editors.currentEditor) {
                var editor = editors.currentEditor.ceEditor.$editor;
                editor.on("changeSession", function() {
                    // Time out a litle, to let the page path be updated
                    setTimeout(fileChange, 100);
                });
                fileChange();
                clearInterval(checkEditorInterval);
            }
        }, 10);
    },

    hierarchyJsonToXml: function(root, selected) {
        var xmlS = [];
        xmlS.push('<entry name="'); xmlS.push(root.name);
            xmlS.push('" icon="' + root.icon);
            root.meta && xmlS.push('" meta="') && xmlS.push(root.meta);
            root.src && xmlS.push('" src="') && xmlS.push(root.src);
            root === selected && xmlS.push('" selected="true');
            xmlS.push('">\n');
        var items = root.items;
        for (var i = 0; i < items.length; i++) {
            xmlS = xmlS.concat(this.hierarchyJsonToXml(items[i], selected));
        }
        xmlS.push('</entry>');
        return xmlS.join('');
    },

    refreshHierarchy: function(hierId) {
        this.renderHierarchy(this.cachedEvent, hierId);
    },

    renderHierarchy : function(event, hierId) {
        console.log("Rendering heirarchy");
        var ace = editors.currentEditor.ceEditor.$editor;
        var hierarchies = event.data;
        var hierarchy = hierarchies[hierId];

        barHierarchy.setAttribute('visible', true);
        var selected = [];
        mdlHierarchy.load(apf.getXml('<data>' + this.hierarchyJsonToXml(hierarchy, selected) + '</data>'));

        var node = mdlHierarchy.queryNode("//entry[@selected]");
        if(node) {
            treeHierarchy.select(node);
            var htmlNode = apf.xmldb.getHtmlNode(node, treeHierarchy);
            htmlNode.scrollIntoView();
        }
        //document.addEventListener("click", this.closeHierarchy);
        ace.container.addEventListener("DOMMouseScroll", this.closeHierarchy);
        ace.container.addEventListener("mousewheel", this.closeHierarchy);

        apf.popup.setContent("hierarchy", barHierarchy.$ext);
        setTimeout(function() {
            apf.popup.show("hierarchy", {
                x        : editors.currentEditor.ceEditor.getWidth()/2 - 150,
                y        : 0,
                animate  : false,
                ref      : ace.container,
                callback : function() {
                    barHierarchy.setHeight(300);
                    barHierarchy.setWidth(300);
                    sbHierarchy.$resize();
                    setTimeout(function() {
                        treeHierarchy.focus();
                    }, 100);
                }
            });
        }, 0);
    },

    jumpTo: function(el) {
        setTimeout(function() {
            // a source file is available
            var src = el.getAttribute("src");
            if (src) {
                // open the file (if not already open) and switch focus
                var filepath = src.replace("/" + window.cloud9config.projectName, window.cloud9config.davPrefix);
                editors.showFile(filepath);
            }
        });
    },

    jumpToAndClose: function(el) {
        this.jumpTo(el);
        this.closeHierarchy();
    },

    closeHierarchy : function(event) {
        var ace = editors.currentEditor.ceEditor.$editor;
        //document.removeEventListener("click", this.closeHierarchy);
        ace.container.removeEventListener("DOMMouseScroll", this.closeHierarchy);
        ace.container.removeEventListener("mousewheel", this.closeHierarchy);
        barHierarchy.$ext.style.display = "none";
        setTimeout(function() {
            editors.currentEditor.ceEditor.$editor.focus();
        }, 100);
    },

    escapeHierarchy: function(event) {
        if(event.keyCode === 27) {
            this.closeHierarchy();
        }
    }
};
});