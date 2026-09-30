# Perf

**A measured slowness, fixed once.** Sustained work on one metric is [hillclimb.md](hillclimb.md).

1. **Get a number.** Measure a baseline on a realistic case that reproduces the complaint: same machine, same data, median of N. No number, no perf work.
2. **Profile before optimizing.** Load the `diagnose` skill and follow its PERF.md. A strategy family earns an attempt only when the profile shows its signal.
3. **One hypothesis at a time.** Re-measure with the same harness after each change. Keep only changes that move past noise with the tests green. Revert the rest in full.
4. **Caches.** Name what invalidates a cache before claiming its win.
5. **Prove** with before and after numbers from the same harness (load the `prove` skill). **Review**: load the `interrogate` skill and run it with `<commit before this work> fix`.

**Reply:** baseline, final, delta with its unit, the mechanism, what was tried and reverted.
