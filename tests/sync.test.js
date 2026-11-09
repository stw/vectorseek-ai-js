import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// Shared modules are copied into the hosted site and the WordPress plugin; they must not drift.
const shared = ["voice.js", "conversation.js"];
const targets = {
    "nimbex": "../../nimbex/src/static/js/",
    "wordpress plugin": "../../vectorseek-ai-search.wp/js/",
};

for (const file of shared) {
    const source = readFileSync(resolve(__dirname, "../src/", file), "utf8");
    describe(`${file} copies stay in sync`, () => {
        for (const [name, dir] of Object.entries(targets)) {
            const path = resolve(__dirname, dir, file);
            it.skipIf(!existsSync(path))(`${name} copy is identical`, () => {
                expect(readFileSync(path, "utf8")).toBe(source);
            });
        }
    });
}
