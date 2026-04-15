import { bench, group, run as mitataRun, summary, do_not_optimize } from "mitata";
import RE2 from "re2";
import { RE2 as Re2Wasm } from "re2-wasm";
import { RE2JS as Re2Js } from "re2js";
import { command, flag, run } from "cmd-ts";

// ─── Types ───────────────────────────────────────────────────────────────────

interface PatternEntry {
    cat: string;
    name: string;
    pattern: RegExp;
    inputs: Record<string, string>;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeRe2(pattern: RegExp): InstanceType<typeof RE2> | null {
    try { return new RE2(pattern.source, pattern.flags); } catch { return null; }
}

function makeRe2Wasm(pattern: RegExp): InstanceType<typeof Re2Wasm> | null {
    try {
        // re2-wasm always runs in unicode mode and requires the u flag explicitly
        const flags = pattern.flags.includes('u') ? pattern.flags : pattern.flags + 'u';
        return new Re2Wasm(pattern.source, flags);
    } catch { return null; }
}

function makeRe2Js(pattern: RegExp): ReturnType<typeof Re2Js.compile> | null {
    try {
        let flags = 0;
        if (pattern.flags.includes("i")) flags |= Re2Js.CASE_INSENSITIVE;
        if (pattern.flags.includes("m")) flags |= Re2Js.MULTILINE;
        if (pattern.flags.includes("s")) flags |= Re2Js.DOTALL;
        return Re2Js.compile(pattern.source, flags);
    } catch { return null; }
}

function makeExp(pattern: RegExp, hasExp: boolean): RegExp | null {
    if (!hasExp) return null;
    // l flag is incompatible with i and u — skip rather than silently change semantics
    if (/[iu]/.test(pattern.flags)) return null;
    try {
        return new RegExp(pattern.source, pattern.flags + "l");
    } catch { return null; }
}

// ─── Pattern definitions ────────────────────────────────────────────────────

const PATTERNS: PatternEntry[] = [
    // ── Simple / Literal ─────────────────────────────────────────
    {
        cat: "Simple Literal", name: "literal word", pattern: /function/,
        inputs: {hit: 'export function handleRequest(req) {}', miss: 'const handler = (req) => {}'},
    },
    {
        cat: "Simple Literal", name: "case-insensitive", pattern: /error/i,
        inputs: {hit: "TypeError: Cannot read properties", miss: "Request completed status 200"},
    },

    // ── Character Classes ────────────────────────────────────────
    {
        cat: "Char Classes", name: "identifier", pattern: /[a-zA-Z_]\w+/,
        inputs: {hit: "    const myVar_123 = getValue();", miss: "    12345 + 67890    "},
    },
    {
        cat: "Char Classes", name: "hex color", pattern: /#[0-9a-fA-F]{6}/,
        inputs: {hit: "color: #ff3b2e; border: #cccccc;", miss: "color: rgb(255, 59, 46);"},
    },
    {
        cat: "Char Classes", name: "\\d+ (global)", pattern: /\d+/g,
        inputs: {hit: "processed 1523 records in 42ms, 3 errors", miss: "no numbers here at all"},
    },

    // ── Anchored ─────────────────────────────────────────────────
    {
        cat: "Anchored", name: "^import\\s", pattern: /^import\s/,
        inputs: {hit: 'import { useState } from "react";', miss: '// import disabled'},
    },
    {
        cat: "Anchored", name: ";\\s*$", pattern: /;\s*$/,
        inputs: {hit: "    return x.map(y => y * 2);", miss: "    return x.map(y => y * 2)"},
    },

    // ── Alternation ──────────────────────────────────────────────
    {
        cat: "Alternation", name: "(const|let|var)", pattern: /\b(const|let|var)\s+\w+/,
        inputs: {hit: "    const userCount = await db.count();", miss: "    return await db.count();"},
    },
    {
        cat: "Alternation", name: "log level 5-way", pattern: /\b(DEBUG|INFO|WARN|ERROR|FATAL)\b/,
        inputs: {hit: "[10:23:45Z] ERROR Failed to connect", miss: "[10:23:45Z] Request processed ok"},
    },
    {
        cat: "Alternation", name: "file ext", pattern: /\.(ts|tsx|js|jsx)$/,
        inputs: {hit: "src/UserProfile.tsx", miss: "src/UserProfile.css"},
    },

    // ── Quantifiers ──────────────────────────────────────────────
    {
        cat: "Quantifiers", name: '"[^"]*"', pattern: /"[^"]*"/,
        inputs: {hit: 'const msg = "Hello, world!";', miss: "const msg = 42;"},
    },
    {
        cat: "Quantifiers", name: "\\s+ (global)", pattern: /\s+/g,
        inputs: {hit: "    lots     of        irregular         spacing     here    ", miss: "x"},
    },

    // ── Common Code Patterns ─────────────────────────────────────
    {
        cat: "Code Patterns", name: "email-like", pattern: /\S+@\S+\.\S+/,
        inputs: {hit: "Contact user@example.com for help", miss: "Contact our help center"},
    },
    {
        cat: "Code Patterns", name: "IPv4", pattern: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/,
        inputs: {hit: "from 192.168.1.42:8080", miss: "from localhost:8080"},
    },
    {
        cat: "Code Patterns", name: "UUID v4",
        pattern: /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i,
        inputs: {hit: "id: 550e8400-e29b-41d4-a716-446655440000", miss: "id: not-a-valid-uuid"},
    },
    {
        cat: "Code Patterns", name: "semver", pattern: /\d+\.\d+\.\d+/,
        inputs: {hit: '"typescript": "^5.3.2"', miss: '"typescript": "latest"'},
    },
    {
        cat: "Code Patterns", name: "URL path", pattern: /\/api\/v\d+\/\w+/,
        inputs: {hit: "GET /api/v2/users?limit=10", miss: "GET /health HTTP/1.1"},
    },
    {
        cat: "Code Patterns", name: "ISO date", pattern: /\d{4}-\d{2}-\d{2}/,
        inputs: {hit: "created: 2024-01-15T10:23Z", miss: "created: last Tuesday"},
    },
    {
        cat: "Code Patterns", name: "JWT-like",
        pattern: /[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
        inputs: {hit: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", miss: "Basic dXNlcjpwYXNz"},
    },

    // ── Moderate Complexity ──────────────────────────────────────
    {
        cat: "Moderate", name: "HTML tag", pattern: /<\w+[^>]*>/,
        inputs: {hit: '<div class="container" id="main">', miss: "plain text no markup"},
    },
    {
        cat: "Moderate", name: "C-style comment", pattern: /\/\*[^*]*\*+(?:[^/*][^*]*\*+)*\//,
        inputs: {hit: "/* comment */ const x = 1;", miss: "// line comment"},
    },

    // ── Backtracking-Prone ───────────────────────────────────────
    {
        cat: "Backtracking", name: "(a+)+$ classic", pattern: /^(a+)+$/,
        inputs: {hit: "aaaaaaaaaaaaaaaa", miss_11: "aaaaaaaaaaX", miss_20: "aaaaaaaaaaaaaaaaaaaaX", miss_25: "aaaaaaaaaaaaaaaaaaaaaaaaaX"},
    },
    {
        cat: "Backtracking", name: "(\\w+\\s?)+$", pattern: /^(\w+\s?)+$/,
        inputs: {hit: "hello world foo bar", miss: "hello world foo!!!!"},
    },
    {
        cat: "Backtracking", name: "(a*)*b nested", pattern: /^(a*)*b$/,
        inputs: {hit: "aaaaaab", miss_7: "aaaaaac", miss_16: "aaaaaaaaaaaaaaaac"},
    },

    // ── Longer Inputs ────────────────────────────────────────────
    {
        cat: "Longer Inputs", name: "ERROR in 1KB", pattern: /ERROR\s+\S+/,
        inputs: {hit: "x".repeat(500) + " ERROR db_timeout " + "x".repeat(500), miss: "x".repeat(1000)},
    },
    {
        cat: "Longer Inputs", name: "UUID in 2KB",
        pattern: /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i,
        inputs: {hit: "x".repeat(900) + " 550e8400-e29b-41d4-a716-446655440000 " + "x".repeat(900), miss: "x".repeat(2000)},
    },
    {
        cat: "Longer Inputs", name: "\\d+ in 1KB (global)", pattern: /\d+/g,
        inputs: {hit: Array.from({length: 50}, (_, i) => `item${i}:${Math.floor(Math.random() * 9999)}`).join(","), miss: "a".repeat(1000)},
    },
];

// ─── CLI ─────────────────────────────────────────────────────────────────────

const cmd = command({
    name: 'bench',
    args: {
        json: flag({long: 'json', description: 'Output results as JSON instead of pretty-printing'}),
        test: flag({long: 'test', description: 'Run only 2 patterns (for iterating on the benchmark tool)'}),
    },
    handler: async ({json, test}) => {

        // ─── Detect V8 experimental engine ───────────────────────────────────

        let hasExp = false;
        try { new RegExp("x", "l"); hasExp = true; } catch {}

        if (!json) {
            console.log("═══════════════════════════════════════════════════════════════════");
            console.log("    Regex Engine Benchmark — mitata harness");
            console.log(`    Node ${process.version}`);
            console.log(`    Engines: V8, ${hasExp ? "V8-exp (l flag), " : ""}re2 (native), re2-wasm, re2js (pure JS)`);
            if (!hasExp) {
                console.log("    ℹ    V8 experimental engine not available.");
                console.log("         Re-run with: node --enable-experimental-regexp-engine bench.js");
            }
            console.log("═══════════════════════════════════════════════════════════════════\n");
        }

        // ─── Register benchmarks ──────────────────────────────────────────────

        // Track which backtracking patterns are dangerous for V8
        const V8_SKIP = new Set<string>();

        for (const p of (test ? PATTERNS.slice(0, 2) : PATTERNS)) {
            const re2 = makeRe2(p.pattern);
            const re2wasm = makeRe2Wasm(p.pattern);
            const re2js = makeRe2Js(p.pattern);
            const exp = makeExp(p.pattern, hasExp);

            for (const [label, input] of Object.entries(p.inputs)) {
                const isBacktrackMiss = p.cat === "Backtracking" && label.startsWith("miss");
                const parsed = parseInt(label.replace("miss_", ""), 10);
                const missLen = Number.isNaN(parsed) ? input.length : parsed;

                // For long backtracking misses, V8 standard will hang mitata's calibration.
                // Skip V8 standard for inputs that would take exponential time.
                const skipV8 = isBacktrackMiss && missLen >= 20;
                const groupName = `${p.cat} / ${p.name} / ${label} (len=${input.length})`;

                if (skipV8) V8_SKIP.add(groupName);

                summary(() => {
                    group(groupName, () => {
                        if (!skipV8) {
                            bench("V8", () => {
                                do_not_optimize(p.pattern.test(input));
                                p.pattern.lastIndex = 0;
                            });
                        }

                        if (exp !== null) {
                            bench("V8-exp", () => {
                                do_not_optimize(exp.test(input));
                                exp.lastIndex = 0;
                            });
                        }

                        if (re2 !== null) {
                            bench("re2", () => {
                                do_not_optimize(re2.test(input));
                                re2.lastIndex = 0;
                            });
                        }

                        if (re2wasm !== null) {
                            bench("re2-wasm", () => {
                                do_not_optimize(re2wasm.test(input));
                                re2wasm.lastIndex = 0;
                            });
                        }

                        if (re2js !== null) {
                            bench("re2js", () => {
                                do_not_optimize(re2js.test(input));
                            });
                        }
                    });
                });
            }
        }

        // ─── Run ──────────────────────────────────────────────────────────────

        if (!json) {
            if (V8_SKIP.size > 0) {
                console.log("⚠    V8 standard engine skipped for these (would hang):");
                for (const s of V8_SKIP) console.log("     " + s);
                console.log("");
            }

            const unsupported: string[] = [];
            for (const p of PATTERNS) {
                const exp = makeExp(p.pattern, hasExp);
                if (!exp && hasExp) unsupported.push(`${p.name} /${p.pattern.source}/${p.pattern.flags}`);
            }
            if (unsupported.length > 0) {
                console.log("ℹ    V8-exp unsupported (i/u flags):");
                for (const s of unsupported) console.log("     " + s);
                console.log("");
            }
        }

        await mitataRun(json ? {format: 'json'} : {});
    },
});

await run(cmd, process.argv.slice(2));
