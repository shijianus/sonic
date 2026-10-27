// Sonic playlist renderer — builds DOM nodes with textContent only.
// Track names/artists come from third-party providers and must never be parsed as HTML.
(function (global) {
    "use strict";

    function normalizeText(value, fallback) {
        if (value === null || value === undefined) return fallback;
        var text = String(value).trim();
        return text || fallback;
    }

    function createActionButton(doc, className, action, index, title, iconClass) {
        var button = doc.createElement("button");
        button.className = className;
        button.type = "button";
        button.dataset.playlistAction = action;
        button.dataset.index = String(index);
        button.title = title;

        var icon = doc.createElement("i");
        icon.className = iconClass;
        button.appendChild(icon);
        return button;
    }

    function createPlaylistItem(song, index) {
        var doc = global.document;
        var item = doc.createElement("div");
        item.className = "playlist-item";
        item.dataset.index = String(index);
        item.setAttribute("role", "button");
        item.setAttribute("tabindex", "0");

        var title = normalizeText(song && song.name, "未知歌曲");
        var artistValue = song && song.artist;
        var artist = Array.isArray(artistValue)
            ? artistValue.join(", ")
            : normalizeText(artistValue, "未知艺术家");
        item.setAttribute("aria-label", "播放 " + title);

        item.appendChild(doc.createTextNode(title + " - " + artist));
        item.appendChild(
            createActionButton(doc, "playlist-item-remove", "remove", index, "从播放列表移除", "fas fa-times")
        );
        item.appendChild(
            createActionButton(doc, "playlist-item-download", "download", index, "下载", "fas fa-download")
        );

        return item;
    }

    function renderInto(container, songs) {
        if (!container) return;
        var doc = container.ownerDocument;
        var list = Array.isArray(songs) ? songs : [];
        var fragment = doc.createDocumentFragment();
        for (var i = 0; i < list.length; i += 1) {
            fragment.appendChild(createPlaylistItem(list[i], i));
        }
        container.textContent = "";
        container.appendChild(fragment);
    }

    global.SonicPlaylistView = {
        createPlaylistItem: createPlaylistItem,
        renderInto: renderInto,
    };
})(typeof window !== "undefined" ? window : globalThis);
