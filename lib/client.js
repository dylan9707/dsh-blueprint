window.__ModuleLoader__.load({
  id: "dsh-blueprint",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var React = require("react");

    var TAB_ID = "dsh-blueprint/panel";
    var TAB_KIND = "dsh-blueprint";

    function BlueprintPane() {
      return React.createElement("iframe", {
        src: "/plugins/blueprint/editor",
        style: { width: "100%", height: "100%", border: "none", background: "#0B1220", display: "block" }
      });
    }

    exports.inject = ["slots"];

    exports.apply = function apply(ctx) {
      ctx.inject(["sidebarRight", "sidebarRightTabs"], function(native) {
        native.effect(function() {
          return native.sidebarRightTabs.register({
            id: TAB_ID,
            kind: TAB_KIND,
            title: function() { return "Blueprint"; },
            guide: [
              {
                id: "blueprint",
                title: function() { return "Blueprint"; },
                description: function() { return "架构 / 执行流 / 状态设计画布"; },
                order: 60
              }
            ]
          });
        });
        native.slots.inject("sidebar.right.pane.tab", function() {
          return native.slots.register({
            name: "sidebar.right.pane.tab",
            key: TAB_ID
          }, BlueprintPane);
        });
      });
    };

    return module.exports;
  }
});
