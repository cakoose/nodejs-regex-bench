import { createInterface } from 'node:readline';
import { command, run } from 'cmd-ts';

// ─── Mitata JSON types ───────────────────────────────────────────────────────

interface LayoutEntry {name: string;}
interface BenchmarkStats {avg: number;}
interface BenchmarkRun {stats: BenchmarkStats;}
interface Benchmark {alias: string; group: number; runs: BenchmarkRun[];}
interface MitataJson {layout: LayoutEntry[]; benchmarks: Benchmark[];}

// ─── Format helpers ──────────────────────────────────────────────────────────

function fmtNs(ns: number): string {
    if (ns < 1_000) return `${ns.toFixed(1)} ns`;
    if (ns < 1_000_000) return `${(ns / 1_000).toFixed(2)} µs`;
    return `${(ns / 1_000_000).toFixed(2)} ms`;
}

function center(s: string, w: number): string {
    const pad = w - s.length;
    return s.padStart(s.length + Math.floor(pad / 2)).padEnd(w);
}

function fmtRatioCol(values: (number | null)[]): string[] {
    const parts = values.map(v => {
        if (v == null) return null;
        if (v === 1) return {int: '1', dec: ''};
        const s = v.toFixed(1);
        const dot = s.indexOf('.');
        return {int: s.slice(0, dot), dec: s.slice(dot)};
    });
    const maxInt = Math.max(...parts.map(p => p ? p.int.length : 1));
    const maxDec = Math.max(...parts.map(p => p ? p.dec.length : 0));
    return parts.map(p =>
        p == null ? '—'.padStart(maxInt) + ''.padEnd(maxDec) : p.int.padStart(maxInt) + p.dec.padEnd(maxDec)
    );
}

// ─── Input ───────────────────────────────────────────────────────────────────

async function readStdin(): Promise<string> {
    const lines: string[] = [];
    for await (const line of createInterface({input: process.stdin})) {
        lines.push(line);
    }
    return lines.join('\n');
}

// ─── Report ──────────────────────────────────────────────────────────────────

function printReport(json: string): void {
    const {layout, benchmarks}: MitataJson = JSON.parse(json);

    // Map layout index → group name (benchmark.group is a direct index into layout)
    const groupNames = new Map<number, string>(
        layout.map((g, i) => [i, g.name])
    );

    // Group benchmarks by group id (preserving insertion order = definition order)
    const byGroup = new Map<number, Benchmark[]>();
    for (const b of benchmarks) {
        if (!byGroup.has(b.group)) byGroup.set(b.group, []);
        const group = byGroup.get(b.group);
        if (group !== undefined) group.push(b);
    }

    // Engine names in order of first appearance
    const engines: string[] = [];
    for (const b of benchmarks) {
        if (!engines.includes(b.alias)) engines.push(b.alias);
    }

    // Collect raw data
    interface RawRow {name: string; onex: string; ratios: (number | null)[];}
    const rawRows: RawRow[] = [];
    for (const [id, benches] of byGroup) {
        const name = groupNames.get(id) ?? String(id);
        const avgs = engines.map(engine => {
            const b = benches.find(x => x.alias === engine);
            return b?.runs.at(0)?.stats.avg ?? null;
        });
        const fastest = Math.min(...avgs.filter((v): v is number => v != null));
        rawRows.push({name, onex: fmtNs(fastest), ratios: avgs.map(avg => avg == null ? null : avg / fastest)});
    }

    // Format ratio columns with decimal alignment
    const formattedRatioCols = engines.map((_, ei) =>
        fmtRatioCol(rawRows.map(r => r.ratios[ei]))
    );

    // Assemble and print table
    const rows = rawRows.map(({name, onex}, ri) => [
        name, onex, ...engines.map((_, ei) => formattedRatioCols[ei][ri]),
    ]);

    const headers = ['Group', '1x', ...engines];
    const widths = headers.map((h, i) =>
        Math.max(h.length, ...rows.map(r => (r[i] ?? '—').length))
    );

    console.log(headers.map((h, i) => center(h, widths[i])).join('    '));
    console.log(widths.map(w => '─'.repeat(w)).join('    '));
    for (const row of rows) {
        console.log(row.map((cell, i) =>
            i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i])
        ).join('    '));
    }
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

const cmd = command({
    name: 'report',
    args: {},
    handler: async () => {
        printReport(await readStdin());
    },
});

await run(cmd, process.argv.slice(2));
