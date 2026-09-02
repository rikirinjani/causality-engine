/**
 * The interactive demo.
 *
 * Runs the real CE engine in the visitor's browser. Every number displayed —
 * prices, hashes, timeline ids, causal chains — is computed by CE at that
 * moment. Nothing is scripted or replayed.
 *
 * The interaction is a guided sequence rather than a free sandbox, because the
 * point is to make three specific properties legible in under a minute:
 * deterministic consequence, retrospective attribution, and divergent timelines.
 * Controls unlock in order so a first-time visitor cannot get lost.
 */
import {
  createDemo,
  DEMO_REGION,
  DEMO_STRUCTURES,
  type CeDemo,
  type WorldView,
} from "../ce-browser.js";

type Stage =
  | "initial"
  | "checkpointed"
  | "acted"
  | "advanced"
  | "explained"
  | "forked"
  | "compared";

interface Els {
  root: HTMLElement;
  tick: HTMLElement;
  hash: HTMLElement;
  timeline: HTMLElement;
  price: HTMLElement;
  priceNode: HTMLElement;
  stock: HTMLElement;
  stockNode: HTMLElement;
  road: HTMLElement;
  roadNode: HTMLElement;
  hostility: HTMLElement;
  hostilityNode: HTMLElement;
  roadEdge: HTMLElement;
  log: HTMLElement;
  why: HTMLElement;
  compare: HTMLElement;
  hint: HTMLElement;
  btnDestroy: HTMLButtonElement;
  btnAdvance: HTMLButtonElement;
  btnWhy: HTMLButtonElement;
  btnCheckpoint: HTMLButtonElement;
  btnFork: HTMLButtonElement;
  btnCompare: HTMLButtonElement;
  btnReset: HTMLButtonElement;
}

const HINTS: Record<Stage, string> = {
  initial:
    "Riverford is at rest. <b>Checkpoint</b> first so you can branch from this moment later — or go straight to destroying the road.",
  checkpointed:
    "Branch point saved. Now <b>destroy the grain road</b> and give CE something to propagate.",
  acted:
    "CE accepted the action but no time has passed. <b>Advance 5 ticks</b> to let consequences unfold.",
  advanced:
    "The price moved and the route broke. Ask <b>why grain is expensive</b> — CE will trace it back.",
  explained:
    "That chain came from CE's provenance graph, not a guess. <b>Fork timeline B</b> from your checkpoint to try a different action.",
  forked: "Two worlds now exist from the same starting point. <b>Compare</b> them.",
  compared:
    "Same seed, same engine, two different histories. Reset and the whole run repeats identically.",
};

function fmt(value: number, places = 2): string {
  return value.toFixed(places);
}

function short(hash: string, chars = 8): string {
  return hash.slice(0, chars);
}

export function mountDemo(root: HTMLElement): void {
  const q = <T extends HTMLElement>(sel: string): T => {
    const found = root.querySelector<T>(sel);
    if (found === null) throw new Error(`demo: missing element ${sel}`);
    return found;
  };

  const els: Els = {
    root,
    tick: q("[data-tick]"),
    hash: q("[data-hash]"),
    timeline: q("[data-timeline]"),
    price: q("[data-price]"),
    priceNode: q("[data-node=price]"),
    stock: q("[data-stock]"),
    stockNode: q("[data-node=stock]"),
    road: q("[data-road]"),
    roadNode: q("[data-node=road]"),
    hostility: q("[data-hostility]"),
    hostilityNode: q("[data-node=hostility]"),
    roadEdge: q("[data-edge=road]"),
    log: q("[data-log]"),
    why: q("[data-why]"),
    compare: q("[data-compare]"),
    hint: q("[data-hint]"),
    btnDestroy: q<HTMLButtonElement>("[data-act=destroy]"),
    btnAdvance: q<HTMLButtonElement>("[data-act=advance]"),
    btnWhy: q<HTMLButtonElement>("[data-act=why]"),
    btnCheckpoint: q<HTMLButtonElement>("[data-act=checkpoint]"),
    btnFork: q<HTMLButtonElement>("[data-act=fork]"),
    btnCompare: q<HTMLButtonElement>("[data-act=compare]"),
    btnReset: q<HTMLButtonElement>("[data-act=reset]"),
  };

  let demo: CeDemo | null = null;
  let branch: CeDemo | null = null;
  let checkpoint: string | null = null;
  let stage: Stage = "initial";
  let previous: WorldView | null = null;

  // ── Log ─────────────────────────────────────────────────────────────
  type LogKind = "you" | "ce" | "warn" | "err";

  function log(kind: LogKind, text: string, seq?: number): void {
    const empty = els.log.querySelector(".log__empty");
    if (empty !== null) empty.remove();

    const line = document.createElement("div");
    line.className = `log__line log__line--${kind}`;

    const marker = document.createElement("span");
    marker.className = "log__seq";
    marker.textContent = seq === undefined ? (kind === "you" ? "→" : "·") : String(seq);

    const body = document.createElement("span");
    body.textContent = text;

    line.append(marker, body);
    els.log.append(line);
    els.log.scrollTop = els.log.scrollHeight;
  }

  // ── Rendering ───────────────────────────────────────────────────────

  function setHint(next: Stage): void {
    stage = next;
    els.hint.innerHTML = HINTS[next];
  }

  function render(view: WorldView, opts: { flashChanges?: boolean } = {}): void {
    const region = view.regions[DEMO_REGION];
    if (region === undefined) return;

    const price = region.prices["grain"] ?? 0;
    const stock = region.stocks["grain"] ?? 0;
    const road = region.infrastructure[DEMO_STRUCTURES.road];
    const roadIntact = road?.intact ?? false;

    // Faction hostility toward the region, as CE reports it.
    const hostilityEntries = Object.entries(view.relations).filter(([key]) =>
      key.endsWith(`>${DEMO_REGION}`),
    );
    const hostility = hostilityEntries.length > 0 ? (hostilityEntries[0]?.[1] ?? 0) : 0;

    els.tick.textContent = String(view.tick);
    els.hash.textContent = short(view.stateHash);
    els.timeline.textContent = view.timelineId;

    els.price.textContent = fmt(price);
    els.stock.textContent = fmt(stock, 1);
    els.road.textContent = roadIntact ? "intact" : "destroyed";
    els.hostility.textContent = fmt(hostility);

    els.roadNode.classList.toggle("node--broken", !roadIntact);
    els.roadEdge.classList.toggle("edge--live", roadIntact);

    if (opts.flashChanges === true && previous !== null) {
      const before = previous.regions[DEMO_REGION];
      const beforePrice = before?.prices["grain"] ?? price;
      const beforeStock = before?.stocks["grain"] ?? stock;
      const beforeHostility =
        Object.entries(previous.relations).filter(([k]) => k.endsWith(`>${DEMO_REGION}`))[0]?.[1] ??
        hostility;

      els.priceNode.classList.toggle("node--changed", price !== beforePrice);
      els.stockNode.classList.toggle("node--changed", stock !== beforeStock);
      els.hostilityNode.classList.toggle("node--changed", hostility !== beforeHostility);
    }

    previous = view;
  }

  function enable(...buttons: HTMLButtonElement[]): void {
    for (const button of buttons) button.disabled = false;
  }

  function disable(...buttons: HTMLButtonElement[]): void {
    for (const button of buttons) button.disabled = true;
  }

  // ── Actions ─────────────────────────────────────────────────────────

  function onDestroy(): void {
    if (demo === null) return;

    log("you", `intervene destroy_infrastructure → ${DEMO_STRUCTURES.road} @ ${DEMO_REGION}`);
    const result = demo.act(
      "destroy_infrastructure",
      DEMO_STRUCTURES.road,
      "infrastructure",
      DEMO_REGION,
    );

    if (!result.ok) {
      // CE refuses to destroy an already-destroyed structure. Showing the
      // rejection is more honest than hiding it.
      log("err", `CE rejected: ${result.errors.join("; ")}`);
      return;
    }

    log("ce", "CE accepted the intervention. No time has passed yet.");
    render(demo.view());
    disable(els.btnDestroy);
    enable(els.btnAdvance);
    setHint("acted");
  }

  function onAdvance(): void {
    if (demo === null) return;

    log("you", "advance 5 ticks");
    const view = demo.advance(5);

    const events = demo.drainEvents();
    for (const event of events) {
      log("ce", event.regionId === undefined ? event.type : `${event.type} @ ${event.regionId}`, event.streamSeq);
    }
    if (events.length === 0) log("ce", "no events emitted");

    render(view, { flashChanges: true });
    log("ce", `tick ${view.tick} · stateHash ${short(view.stateHash, 12)}`);

    enable(els.btnWhy, els.btnCheckpoint, els.btnAdvance);
    if (stage === "acted") setHint("advanced");
  }

  function onWhy(): void {
    if (demo === null) return;

    const key = demo.quantity.price(DEMO_REGION, "grain");
    log("you", `why(${key})`);
    const cause = demo.why(key);

    const status = !cause.explained
      ? "no recorded cause"
      : cause.incomplete
        ? "explained · trace incomplete"
        : "explained";

    let markup = `<div class="why__head"><span class="why__q">why(${key})</span><span class="why__status">${status}</span></div>`;

    if (!cause.explained) {
      markup +=
        '<p class="log__empty">CE found no recorded cause for this value. It reports that rather than inventing one.</p>';
    } else {
      const chain = cause.chains[0] ?? [];
      markup += '<ol class="chain">';
      // Nearest cause first, originating action last.
      for (let i = 0; i < chain.length; i += 1) {
        const isRoot = i === chain.length - 1;
        markup += `<li${isRoot ? ' class="chain__root"' : ""}>${chain[i]}</li>`;
      }
      markup += "</ol>";

      if (cause.rootActions.length > 0) {
        const root = cause.rootActions[0]!;
        markup += `<p class="why__status" style="margin-top:var(--sp-3)">originating action: <b style="color:var(--amber-400)">${root.action}</b> on <b style="color:var(--amber-400)">${root.targetId}</b> at tick ${root.tick}</p>`;
      }
    }

    els.why.innerHTML = markup;
    els.why.hidden = false;

    log("ce", cause.explained ? `attribution: ${cause.rootActions[0]?.action ?? "?"}` : "unexplained");
    if (stage === "advanced") setHint("explained");
  }

  function onCheckpoint(): void {
    if (demo === null) return;

    log("you", "checkpoint");
    const save = demo.save();
    checkpoint = save.data;

    log("ce", `checkpoint ${save.checkpointId} @ tick ${save.tick}`);
    enable(els.btnFork);

    // A checkpoint taken before the road is destroyed is what makes the two
    // timelines meaningfully different. Taking it later is allowed, but then
    // both branches inherit the destroyed road.
    if (stage === "initial") setHint("checkpointed");
  }

  function onFork(): void {
    if (demo === null || checkpoint === null) return;

    log("you", 'fork timeline "B" from checkpoint');
    const result = demo.fork(checkpoint, "B");

    if (!result.ok || result.demo === undefined) {
      log("err", `fork failed: ${result.errors.join("; ")}`);
      return;
    }

    branch = result.demo;
    log("ce", `timeline B created: ${branch.timeline().timelineId}`);

    // Diverge: subsidise instead of destroying.
    log("you", `intervene grant_merchant_subsidy → ${DEMO_REGION} @ ${DEMO_REGION} (timeline B)`);
    const acted = branch.act("grant_merchant_subsidy", DEMO_REGION, "region", DEMO_REGION);
    if (!acted.ok) {
      log("err", `CE rejected on B: ${acted.errors.join("; ")}`);
      return;
    }

    const bView = branch.advance(5);
    branch.drainEvents();
    log("ce", `timeline B advanced to tick ${bView.tick} · ${short(bView.stateHash, 12)}`);

    enable(els.btnCompare);
    setHint("forked");
  }

  function onCompare(): void {
    if (demo === null || branch === null) return;

    log("you", "compare timeline A against timeline B");
    const comparison = demo.compare(branch);
    const a = demo.view();
    const b = branch.view();

    const aRegion = a.regions[DEMO_REGION];
    const bRegion = b.regions[DEMO_REGION];

    const side = (
      klass: string,
      name: string,
      view: WorldView,
      region: typeof aRegion,
    ): string => `
      <div class="branch ${klass}">
        <div class="branch__name">${name}</div>
        <dl>
          <div class="branch__row"><dt>timeline</dt><dd>${view.timelineId}</dd></div>
          <div class="branch__row"><dt>grain</dt><dd>${fmt(region?.prices["grain"] ?? 0)}</dd></div>
          <div class="branch__row"><dt>stock</dt><dd>${fmt(region?.stocks["grain"] ?? 0, 1)}</dd></div>
          <div class="branch__row"><dt>road</dt><dd>${region?.infrastructure[DEMO_STRUCTURES.road]?.intact === true ? "intact" : "destroyed"}</dd></div>
          <div class="branch__row"><dt>stateHash</dt><dd>${short(view.stateHash)}</dd></div>
        </dl>
      </div>`;

    const verdict = comparison.stateHashEqual
      ? "Identical worlds."
      : comparison.traceHashEqual
        ? "Different worlds, same recorded history — which should not happen; please report it."
        : `Different worlds, different histories. CE reports <b>${comparison.differences.length}</b> diverging quantities.`;

    els.compare.innerHTML = `
      <div class="compare__grid">
        ${side("branch--a", "Timeline A — bridge destroyed", a, aRegion)}
        ${side("branch--b", "Timeline B — merchants subsidised", b, bRegion)}
      </div>
      <p class="compare__verdict">
        distinct <b>${String(comparison.distinct)}</b> ·
        same state <b>${String(comparison.stateHashEqual)}</b> ·
        same history <b>${String(comparison.traceHashEqual)}</b><br>${verdict}
      </p>`;
    els.compare.hidden = false;

    log(
      "ce",
      `distinct=${comparison.distinct} stateEqual=${comparison.stateHashEqual} diffs=${comparison.differences.length}`,
    );
    setHint("compared");
  }

  function onReset(): void {
    if (demo === null) return;

    branch = null;
    checkpoint = null;
    previous = null;

    els.log.innerHTML = '<div class="log__empty">Awaiting your first intervention.</div>';
    els.why.hidden = true;
    els.compare.hidden = true;

    for (const node of [els.priceNode, els.stockNode, els.hostilityNode]) {
      node.classList.remove("node--changed");
    }

    const view = demo.reset(42);
    render(view);
    log("ce", `world created · seed 42 · ${short(view.stateHash, 12)}`);

    disable(els.btnAdvance, els.btnWhy, els.btnFork, els.btnCompare);
    enable(els.btnDestroy, els.btnCheckpoint);
    setHint("initial");
  }

  // ── Boot ────────────────────────────────────────────────────────────

  els.btnDestroy.addEventListener("click", onDestroy);
  els.btnAdvance.addEventListener("click", onAdvance);
  els.btnWhy.addEventListener("click", onWhy);
  els.btnCheckpoint.addEventListener("click", onCheckpoint);
  els.btnFork.addEventListener("click", onFork);
  els.btnCompare.addEventListener("click", onCompare);
  els.btnReset.addEventListener("click", onReset);

  createDemo(42)
    .then((instance) => {
      demo = instance;
      const view = instance.view();
      render(view);
      log("ce", `world created · seed 42 · ${short(view.stateHash, 12)}`);
      enable(els.btnDestroy, els.btnCheckpoint, els.btnReset);
      setHint("initial");
    })
    .catch((error: unknown) => {
      log("err", `engine failed to load: ${String(error)}`);
      els.hint.textContent =
        "The demo engine failed to load. The install instructions below still work.";
    });
}
