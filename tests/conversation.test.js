// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Conversation } from "../src/conversation.js";

let host, container, loader;

function make(opts = {}) {
    document.body.innerHTML = `
      <div id="host">
        <div id="loader">loading</div>
        <div id="results"></div>
      </div>`;
    host = document.getElementById("host");
    container = document.getElementById("results");
    loader = document.getElementById("loader");
    const conv = new Conversation({ container, loader, images: { up: "up.svg", down: "down.svg" }, ...opts });
    return conv;
}

describe("single-answer mode (default)", () => {
    it("replaces the previous result and returns the container", () => {
        const conv = make();
        container.innerHTML = "<p>old answer</p>";
        const target = conv.startTurn("first");
        expect(target).toBe(container);
        expect(container.children).toHaveLength(0);
        expect(conv.target).toBe(container);
        expect(host.querySelector(".vs-turn")).toBeNull();
        expect(host.querySelector(".vs-conv-tools")).toBeNull();
    });

    it("does not add rating rows", () => {
        const conv = make();
        conv.startTurn("q");
        conv.finishTurn({ id: 5, token: "t" });
        expect(host.querySelector(".vs-turn-rate")).toBeNull();
    });
});

describe("conversation mode", () => {
    it("appends a turn per question and keeps earlier ones", () => {
        const conv = make();
        conv.setEnabled(true);
        const a1 = conv.startTurn("What is X?");
        a1.textContent = "X is a thing.";
        const a2 = conv.startTurn("And Y?");
        a2.textContent = "Y is another.";

        const turns = container.querySelectorAll(".vs-turn");
        expect(turns).toHaveLength(2);
        expect(turns[0].querySelector(".vs-question").textContent).toBe("What is X?");
        expect(turns[0].querySelector(".vs-answer").textContent).toBe("X is a thing.");
        expect(turns[1].querySelector(".vs-question").textContent).toBe("And Y?");
        expect(conv.target).toBe(a2);
        expect(a1).not.toBe(a2);
    });

    it("renders the question as text, never HTML", () => {
        const conv = make();
        conv.setEnabled(true);
        conv.startTurn('<img src=x onerror="alert(1)"><b>hi</b>');
        const q = container.querySelector(".vs-question");
        expect(q.querySelector("img")).toBeNull();
        expect(q.querySelector("b")).toBeNull();
        expect(q.textContent).toBe('<img src=x onerror="alert(1)"><b>hi</b>');
    });

    it("moves the loader into the active turn and back on clear", () => {
        const conv = make();
        conv.setEnabled(true);
        conv.startTurn("one");
        expect(loader.parentElement.className).toBe("vs-loader-slot");
        conv.startTurn("two");
        const slots = container.querySelectorAll(".vs-loader-slot");
        expect(slots[1].contains(loader)).toBe(true);
        expect(slots[0].contains(loader)).toBe(false);
        conv.clear();
        expect(loader.parentElement).toBe(host);          // back where it started
        expect(container.querySelectorAll(".vs-turn")).toHaveLength(0);
    });

    it("shows a Clear conversation button after the first turn", () => {
        const conv = make();
        conv.setEnabled(true);
        conv.startTurn("hello");
        const tools = host.querySelector(".vs-conv-tools");
        expect(tools).not.toBeNull();
        expect(tools.hidden).toBe(false);
        expect(tools.nextElementSibling).toBe(container);   // sits above the conversation
        expect(host.querySelectorAll(".vs-conv-tools")).toHaveLength(1);
        conv.startTurn("again");
        expect(host.querySelectorAll(".vs-conv-tools")).toHaveLength(1);
    });

    it("clear removes all turns, hides the button and calls onClear", () => {
        const onClear = vi.fn();
        const conv = make({ onClear });
        conv.setEnabled(true);
        conv.startTurn("a");
        conv.startTurn("b");
        host.querySelector(".vs-clear-btn").click();
        expect(container.querySelectorAll(".vs-turn")).toHaveLength(0);
        expect(host.querySelector(".vs-conv-tools").hidden).toBe(true);
        expect(onClear).toHaveBeenCalledTimes(1);
        expect(conv.target).toBe(container);
    });

    it("switching back to single mode replaces content again", () => {
        const conv = make();
        conv.setEnabled(true);
        conv.startTurn("a");
        conv.setEnabled(false);
        expect(conv.startTurn("b")).toBe(container);
        expect(container.querySelector(".vs-turn")).toBeNull();
    });
});

describe("per-answer rating", () => {
    it("adds a rating row to the answered turn only", () => {
        const conv = make();
        conv.setEnabled(true);
        conv.startTurn("one");
        conv.finishTurn({ id: 11, token: "tok1" });
        conv.startTurn("two");
        const turns = container.querySelectorAll(".vs-turn");
        expect(turns[0].querySelector(".vs-turn-rate")).not.toBeNull();
        expect(turns[1].querySelector(".vs-turn-rate")).toBeNull();
    });

    it("sends the answer's id and token with the vote, then says thanks", () => {
        const onRate = vi.fn();
        const conv = make({ onRate });
        conv.setEnabled(true);
        conv.startTurn("one");
        conv.finishTurn({ id: 11, token: "tok1" });
        conv.startTurn("two");
        conv.finishTurn({ id: 12, token: "tok2" });

        const rows = container.querySelectorAll(".vs-turn-rate");
        rows[0].querySelector(".vs-rate-down").click();
        expect(onRate).toHaveBeenCalledWith(11, "tok1", -1);
        expect(rows[0].textContent).toBe("Thank you!");
        expect(rows[1].textContent).toContain("Was this answer helpful?");   // other row untouched

        rows[1].querySelector(".vs-rate-up").click();
        expect(onRate).toHaveBeenLastCalledWith(12, "tok2", 1);
    });

    it("uses the thumb images, resolved lazily, with an accessible label", () => {
        const conv = make({ images: () => ({ up: "lazy-up.svg", down: "lazy-down.svg" }) });
        conv.setEnabled(true);
        conv.startTurn("q");
        conv.finishTurn({ id: 1, token: "t" });
        const up = container.querySelector(".vs-rate-up");
        expect(up.querySelector("img").getAttribute("src")).toBe("lazy-up.svg");
        expect(up.getAttribute("aria-label")).toBe("Yes, helpful");
    });

    it("gives the thumbs their own classes (the old widget-only classes collapsed to 0x0 outside the rating block)", () => {
        const conv = make();
        conv.setEnabled(true);
        conv.startTurn("q");
        conv.finishTurn({ id: 1, token: "t" });
        const up = container.querySelector(".vs-rate-up img");
        const down = container.querySelector(".vs-rate-down img");
        expect(up.className).toBe("vs-rate-img vs-rate-img-up");
        expect(down.className).toBe("vs-rate-img vs-rate-img-down");
        expect(up.classList.contains("vectorseek_thumbs_up")).toBe(false);
    });

    it("falls back to text buttons without images", () => {
        const conv = make({ images: undefined });
        conv.setEnabled(true);
        conv.startTurn("q");
        conv.finishTurn({ id: 1, token: "t" });
        expect(container.querySelector(".vs-rate-up").textContent).toBe("Yes");
    });

    it("ignores finishTurn without an id", () => {
        const conv = make();
        conv.setEnabled(true);
        conv.startTurn("q");
        conv.finishTurn({});
        expect(container.querySelector(".vs-turn-rate")).toBeNull();
    });
});

describe("sources and context accordion", () => {
    const sources = [
        { title: "Pricing", url: "https://example.com/pricing", confidence: 0.91 },
        { title: "FAQ", url: "https://example.com/faq", confidence: 0.45 },
    ];

    function convWithTurn() {
        const conv = make();
        conv.setEnabled(true);
        conv.startTurn("how much?");
        return conv;
    }

    it("adds a collapsed accordion under the answer", () => {
        const conv = convWithTurn();
        conv.addReferences({ sources });
        const details = container.querySelector(".vs-turn details.vs-refs");
        expect(details).not.toBeNull();
        expect(details.open).toBe(false);                       // collapsed by default
        expect(details.hasAttribute("open")).toBe(false);
        expect(details.querySelector("summary").textContent).toBe("Sources (2)");
        expect(details.previousElementSibling.className).toBe("vs-answer");
    });

    it("lists sources with number, confidence, safe links and confidence classes", () => {
        const conv = convWithTurn();
        conv.addReferences({ sources });
        const rows = container.querySelectorAll(".vs-source");
        expect(rows).toHaveLength(2);
        expect(rows[0].classList.contains("conf-excellent")).toBe(true);
        expect(rows[1].classList.contains("conf-poor")).toBe(true);
        expect(rows[0].textContent).toBe("1 - 91% - Pricing");
        const a = rows[0].querySelector("a");
        expect(a.getAttribute("href")).toBe("https://example.com/pricing");
        expect(a.getAttribute("target")).toBe("_blank");
        expect(a.getAttribute("rel")).toContain("noopener");
    });

    it("shows context in the same accordion when provided, with the search type", () => {
        const conv = convWithTurn();
        conv.addReferences({ sources, contexts: ["Plans start at $10.", "Billed monthly."], searchTypes: ["vector", "keyword"] });
        const details = container.querySelector("details.vs-refs");
        expect(details.querySelector("summary").textContent).toBe("Sources & context (2)");
        const ctx = details.querySelectorAll(".vs-context");
        expect(ctx).toHaveLength(2);
        expect(ctx[0].textContent).toBe("VectorPlans start at $10.");
        expect(ctx[1].querySelector(".vs-context-type").textContent).toBe("Keyword");
    });

    it("omits context when the page does not show it", () => {
        const conv = convWithTurn();
        conv.addReferences({ sources });
        expect(container.querySelector(".vs-contexts")).toBeNull();
        expect(container.querySelector("summary").textContent).toBe("Sources (2)");
    });

    it("context-only answers are labelled Context", () => {
        const conv = convWithTurn();
        conv.addReferences({ contexts: ["only context"] });
        expect(container.querySelector("summary").textContent).toBe("Context");
    });

    it("never inserts source titles or context as HTML", () => {
        const conv = convWithTurn();
        conv.addReferences({
            sources: [{ title: '<img src=x onerror="alert(1)">', url: "https://example.com/a", confidence: 0.9 }],
            contexts: ['<script>alert(1)</script><b>bold</b>'],
        });
        expect(container.querySelector(".vs-refs img")).toBeNull();
        expect(container.querySelector(".vs-refs script")).toBeNull();
        expect(container.querySelector(".vs-refs b")).toBeNull();
        expect(container.querySelector(".vs-source a").textContent).toBe('<img src=x onerror="alert(1)">');
        expect(container.querySelector(".vs-context").textContent).toBe('<script>alert(1)</script><b>bold</b>');
    });

    it("does not link javascript: or data: urls", () => {
        const conv = convWithTurn();
        conv.addReferences({ sources: [
            { title: "bad", url: "javascript:alert(1)", confidence: 0.9 },
            { title: "also bad", url: "data:text/html,<b>x</b>", confidence: 0.9 },
            { title: "relative", url: "/docs/page", confidence: 0.9 },
        ] });
        const rows = container.querySelectorAll(".vs-source");
        expect(rows[0].querySelector("a")).toBeNull();
        expect(rows[1].querySelector("a")).toBeNull();
        expect(rows[0].textContent).toContain("bad");
        expect(rows[2].querySelector("a").getAttribute("href")).toMatch(/^https?:\/\/.*\/docs\/page$/);
    });

    it("falls back to the url when a source has no title", () => {
        const conv = convWithTurn();
        conv.addReferences({ sources: [{ url: "https://example.com/x", confidence: 0.7 }] });
        expect(container.querySelector(".vs-source a").textContent).toBe("https://example.com/x");
    });

    it("each turn gets its own accordion and earlier ones are untouched", () => {
        const conv = make();
        conv.setEnabled(true);
        conv.startTurn("one");
        conv.addReferences({ sources: [sources[0]] });
        conv.startTurn("two");
        conv.addReferences({ sources });
        const all = container.querySelectorAll("details.vs-refs");
        expect(all).toHaveLength(2);
        expect(all[0].querySelector("summary").textContent).toBe("Sources (1)");
        expect(all[1].querySelector("summary").textContent).toBe("Sources (2)");
    });

    it("merges sources and context that arrive in separate messages", () => {
        const conv = convWithTurn();
        conv.addReferences({ sources });
        conv.addReferences({ contexts: ["late context"] });
        expect(container.querySelectorAll("details.vs-refs")).toHaveLength(1);
        expect(container.querySelector("summary").textContent).toBe("Sources & context (2)");
    });

    it("keeps the rating row after the accordion", () => {
        const conv = convWithTurn();
        conv.addReferences({ sources });
        conv.finishTurn({ id: 1, token: "t" });
        const turn = container.querySelector(".vs-turn");
        const kids = Array.from(turn.children).map(c => c.className.split(" ")[0]);
        expect(kids).toEqual(["vs-question", "vs-loader-slot", "vs-answer", "vs-refs", "vs-turn-rate"]);

        const conv2 = convWithTurn();            // references arriving after the rating row still go before it
        conv2.finishTurn({ id: 2, token: "t" });
        conv2.addReferences({ sources });
        const kids2 = Array.from(container.querySelectorAll(".vs-turn")[0].children).map(c => c.className.split(" ")[0]);
        expect(kids2.slice(-2)).toEqual(["vs-refs", "vs-turn-rate"]);
    });

    it("does nothing outside conversation mode, without data, or before a turn exists", () => {
        const single = make();
        single.startTurn("q");
        single.addReferences({ sources });
        expect(container.querySelector(".vs-refs")).toBeNull();

        const conv = make();
        conv.setEnabled(true);
        conv.addReferences({ sources });                        // no turn yet
        expect(container.querySelector(".vs-refs")).toBeNull();

        conv.startTurn("q");
        conv.addReferences({});
        conv.addReferences({ sources: [], contexts: [] });
        expect(container.querySelector(".vs-refs")).toBeNull();
    });

    it("is removed together with the turn when the conversation is cleared", () => {
        const conv = convWithTurn();
        conv.addReferences({ sources });
        conv.clear();
        expect(container.querySelector(".vs-refs")).toBeNull();
    });
});

describe("helpers", () => {
    it("maps confidence to the existing css classes", async () => {
        const { confidenceClass } = await import("../src/conversation.js");
        expect([0.9, 0.75, 0.65, 0.5, 0.1].map(confidenceClass)).toEqual(
            ["conf-excellent", "conf-good", "conf-fair", "conf-poor", "conf-verypoor"]);
    });
});
