// Blind re-walk: the exact Getting Started / INSTALLATION.md Option A snippet,
// typed as documented, in a directory that only ever received the released
// tarball. No repository knowledge used beyond what the documentation shows.
import { createGame, intervene, step, inspect } from "causality-engine/product";

const game = createGame({ seed: 42 });
intervene(game, {
  action: "destroy_infrastructure",
  target: { type: "infrastructure", id: "grain_road" },
  location: "RF",
});
step(game, 5);
console.log(inspect(game).regions.RF.prices.grain);   // documented: 13.13
