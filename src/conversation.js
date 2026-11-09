// Ongoing-conversation display for VectorSeek: keeps each question and answer on the page
// instead of replacing the previous result. No dependencies.
//
// NOTE: copies of this file live in nimbex/src/static/js/conversation.js and
// vectorseek-ai-search.wp/js/conversation.js - keep them in sync.

/** Confidence bucket -> CSS class (matches the existing .conf-* styles). */
export function confidenceClass(confidence) {
    if (confidence >= 0.85) return "conf-excellent";
    if (confidence >= 0.70) return "conf-good";
    if (confidence >= 0.60) return "conf-fair";
    if (confidence >= 0.40) return "conf-poor";
    return "conf-verypoor";
}

/** Only http(s) links are made clickable; anything else (javascript:, data:) is shown as plain text. */
export function safeHref(url, base) {
    try {
        const u = new URL(String(url || ""), base || (typeof location !== "undefined" ? location.href : undefined));
        return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
    } catch (e) {
        return null;
    }
}

export class Conversation {
    /**
     * @param {Object}   opts
     * @param {Element}  opts.container   element that holds the results
     * @param {Element}  [opts.loader]    loading indicator; moved into the active turn
     * @param {Function|Object} [opts.images] {up, down} thumb image urls (or a function returning them)
     * @param {Function} [opts.onRate]    (id, token, +1|-1) called when a visitor rates an answer
     * @param {Function} [opts.onClear]   called after the conversation is cleared (e.g. start a new session)
     */
    constructor({ container, loader, images, onRate, onClear } = {}) {
        this.container = container;
        this.loader = loader || null;
        this.images = images;
        this.onRate = onRate;
        this.onClear = onClear;
        this.enabled = false;
        this.current = null;      // { turn, answer } of the question being answered
        this._tools = null;
        this._loaderHome = loader ? { parent: loader.parentNode, next: loader.nextSibling } : null;
    }

    setEnabled(enabled) {
        this.enabled = !!enabled;
    }

    /** Element answers should be rendered into. */
    get target() {
        return this.current ? this.current.answer : this.container;
    }

    /**
     * Begin a new question. Conversation mode appends a turn and returns its answer element;
     * otherwise the previous result is replaced (the original behaviour) and the container returned.
     */
    startTurn(question) {
        if (!this.enabled) {
            this._restoreLoader();
            this.current = null;
            this.container.textContent = "";
            return this.container;
        }

        const doc = this.container.ownerDocument;
        this._ensureTools();

        const turn = doc.createElement("div");
        turn.className = "vs-turn";

        const q = doc.createElement("div");
        q.className = "vs-question";
        q.textContent = question;                 // text only: never HTML

        const slot = doc.createElement("div");
        slot.className = "vs-loader-slot";

        const answer = doc.createElement("div");
        answer.className = "vs-answer";

        turn.appendChild(q);
        turn.appendChild(slot);
        turn.appendChild(answer);
        this.container.appendChild(turn);
        if (this.loader) slot.appendChild(this.loader);   // show "thinking" next to this question

        this.current = { turn, answer };
        this._tools.hidden = false;
        if (turn.scrollIntoView) {
            try { turn.scrollIntoView({ behavior: "smooth", block: "nearest" }); } catch (e) { turn.scrollIntoView(); }
        }
        return answer;
    }

    /**
     * Sources (and, where the page shows it, retrieved context) for the current answer, in a
     * collapsed accordion under the answer. Everything is inserted as text, never HTML.
     */
    addReferences({ sources, contexts, searchTypes } = {}) {
        if (!this.enabled || !this.current) return;
        const hasSources = Array.isArray(sources) && sources.length > 0;
        const hasContexts = Array.isArray(contexts) && contexts.length > 0;
        if (!hasSources && !hasContexts) return;

        const doc = this.container.ownerDocument;
        const cur = this.current;
        if (!cur.refs) {
            const details = doc.createElement("details");       // collapsed unless "open" is set
            details.className = "vs-refs";
            const summary = doc.createElement("summary");
            summary.className = "vs-refs-summary";
            const body = doc.createElement("div");
            body.className = "vs-refs-body";
            details.appendChild(summary);
            details.appendChild(body);
            const rate = cur.turn.querySelector(".vs-turn-rate");
            cur.turn.insertBefore(details, rate || null);       // keep the rating row last
            cur.refs = { details, summary, body, sources: 0, contexts: 0 };
        }
        const refs = cur.refs;

        if (hasSources) {
            const section = doc.createElement("div");
            section.className = "vs-sources";
            const heading = doc.createElement("h5");
            heading.textContent = "Sources";
            section.appendChild(heading);
            sources.forEach((source, index) => {
                const row = doc.createElement("div");
                const confidence = Number(source.confidence);
                row.className = `vs-source ${confidenceClass(confidence)}`;

                const num = doc.createElement("span");
                num.className = "citation-number";
                num.textContent = `${index + 1} - `;
                row.appendChild(num);
                if (Number.isFinite(confidence)) {
                    const pct = doc.createElement("span");
                    pct.className = "confidence";
                    pct.textContent = `${(confidence * 100).toFixed(0)}% - `;
                    row.appendChild(pct);
                }
                const title = source.title || source.url || "Source";
                const href = safeHref(source.url);
                if (href) {
                    const a = doc.createElement("a");
                    a.href = href;
                    a.target = "_blank";
                    a.rel = "noopener noreferrer";
                    a.textContent = title;
                    row.appendChild(a);
                } else {
                    row.appendChild(doc.createTextNode(title));
                }
                section.appendChild(row);
            });
            refs.body.appendChild(section);
            refs.sources += sources.length;
        }

        if (hasContexts) {
            const section = doc.createElement("div");
            section.className = "vs-contexts";
            const heading = doc.createElement("h5");
            heading.textContent = "Context";
            section.appendChild(heading);
            contexts.forEach((text, index) => {
                const item = doc.createElement("div");
                item.className = "vs-context";
                const type = searchTypes && searchTypes[index];
                if (type) {
                    const badge = doc.createElement("span");
                    badge.className = "vs-context-type";
                    badge.textContent = type === "keyword" ? "Keyword" : "Vector";
                    item.appendChild(badge);
                }
                item.appendChild(doc.createTextNode(String(text)));
                section.appendChild(item);
            });
            refs.body.appendChild(section);
            refs.contexts += contexts.length;
        }

        refs.summary.textContent = refs.contexts
            ? (refs.sources ? `Sources & context (${refs.sources})` : "Context")
            : `Sources (${refs.sources})`;
    }

    /** The answer finished: add a rating row to this turn. */
    finishTurn({ id, token } = {}) {
        if (!this.enabled || !this.current || !id) return;
        const doc = this.container.ownerDocument;
        const { turn } = this.current;
        const row = doc.createElement("div");
        row.className = "vs-turn-rate";

        const label = doc.createElement("span");
        label.className = "vs-rate-text";
        label.textContent = "Was this answer helpful?";
        row.appendChild(label);

        const images = typeof this.images === "function" ? this.images() : (this.images || {});
        const make = (kind, value, alt, fallback) => {
            const btn = doc.createElement("button");
            btn.type = "button";
            btn.className = `vs-rate-btn vs-rate-${kind}`;
            btn.setAttribute("aria-label", alt);
            if (images[kind]) {
                const img = doc.createElement("img");
                img.src = images[kind];
                img.alt = "";
                img.className = kind === "up" ? "vectorseek_thumbs_up" : "vectorseek_thumbs_down";
                btn.appendChild(img);
            } else {
                btn.textContent = fallback;
            }
            btn.addEventListener("click", (e) => {
                e.preventDefault();
                if (this.onRate) this.onRate(id, token || "", value);
                row.textContent = "";
                const thanks = doc.createElement("b");
                thanks.textContent = "Thank you!";
                row.appendChild(thanks);
            });
            return btn;
        };
        row.appendChild(make("up", 1, "Yes, helpful", "Yes"));
        row.appendChild(make("down", -1, "No, not helpful", "No"));
        turn.appendChild(row);
    }

    /** Remove every turn and start fresh. */
    clear() {
        this._restoreLoader();
        this.current = null;
        this.container.textContent = "";
        if (this._tools) this._tools.hidden = true;
        if (this.onClear) this.onClear();
    }

    _restoreLoader() {
        const home = this._loaderHome;
        if (!this.loader || !home || !home.parent) return;
        if (this.loader.parentNode !== home.parent) {
            home.parent.insertBefore(this.loader, home.next && home.next.parentNode === home.parent ? home.next : null);
        }
    }

    _ensureTools() {
        if (this._tools || !this.container.parentNode) return;
        const doc = this.container.ownerDocument;
        const tools = doc.createElement("div");
        tools.className = "vs-conv-tools";
        tools.hidden = true;
        const btn = doc.createElement("button");
        btn.type = "button";
        btn.className = "vs-clear-btn";
        btn.textContent = "Clear conversation";
        btn.addEventListener("click", (e) => { e.preventDefault(); this.clear(); });
        tools.appendChild(btn);
        this.container.parentNode.insertBefore(tools, this.container);
        this._tools = tools;
    }
}
