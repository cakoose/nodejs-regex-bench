# nodejs-regex-bench

(Warning: Generated quickly with AI.)

Compares the performance of a few regex engines on common patterns:
- V8: The built-in backtracking engine.
- [V8-exp](https://v8.dev/blog/non-backtracking-regexp): The experimental engine (inspired by RE2) that doesn't backtrack.
- [re2](https://github.com/uhop/node-re2): The [RE2](https://github.com/google/re2) engine packaged as a Node.js native module.
- [re2js](https://github.com/le0pard/re2js): The RE2 engine reimplemented in JavaScript.

## To build and run

```
yarn install
yarn build
yarn bench:report
```

## Results

- [2026-04-14](results/2026-04-14.md)
