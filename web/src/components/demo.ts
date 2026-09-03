/**
 * The interactive demo.
 *
 * Runs the real CE engine in the visitor's browser. Every number displayed —
 * prices, stocks, hostility, hashes, timeline ids, causal chains — is computed
 * by CE at that moment. Nothing is scripted or replayed from a recording.
 *
 * Design notes, all of them prompted by real confusion from a first-time user:
 *
 * - Values are shown with a **history strip**, not just a current number. Grain
 *   price is non-monotonic (10.00 -> 17.05 -> 13.13 -> 19.84 -> 40.00) and a
 *   single figure hides the overshoot entirely.
 * - When the price reaches CE's clamp ceiling, the UI says so. Otherwise a
 *   correctly-capped economy reads as a stuck one.
 * - Hostility spikes on tick 1 then decays every tick toward a floor. The peak
 *   is labelled, so a decayed value is not mistaken for "nothing happened".
 * - Checkpoints are re-takeable and the branch-point tick is always visible,
 *   because forking the same tick-0 checkpoint three times understandably looks
 *   like the fork tick is being ignored.
 */
import {
  createDemo,
  DEMO_FACTION,
  DEMO_GRAIN_PRICE_CEILING,
  DEMO_HOSTILITY_KEY,
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
  priceNote: HTMLElement;
  priceSpark: HTMLElement;
  stock: HTMLElement;
  stockNode: HTMLElement;
  stockNote: HTMLElement;
  stockSpark: HTMLElement;
  road: HTMLElement;
  roadNode: HTMLElement;
  hostility: HTMLElement;
  hostilityNode: HTMLElement;
  hostilityNote: HTMLElement;
  hostilitySpark: HTMLElement;
  roadEdge: HTMLElement;
  cpState: HTMLElement;
  log: HTMLElement;
  why: HTMLElement;
  compare: HTMLElement;
  hint: HTMLElement;
  btnDestroy: HTMLButtonElement;
  btnAdvance1: HTMLButtonElement;
  btnAdvance5: HTMLButtonElement;
  btnWhy: HTMLButtonElement;
  btnCheckpoint: HTMLButtonElement;
  btnFork: HTMLButtonElement;
  btnCompare: HTMLButtonElement;
  btnReset: HTMLButtonElement;
}

const HINTS: Record<Stage, string> = {
  initial:
    "Riverford is at rest. <b>Checkpoint</b> to mark a branch point you can return to — or go straight to destroying the road.",
  checkpointed:
    "Branch point saved. Now <b>destroy the grain road</b> and give CE something to propagate.",
  acted:
    "CE accepted the action, but no time has passed — the price is unchanged. <b>Advance</b> to let consequences resolve.",
  advanced:
    "Watch the history strips: the price overshoots, then settles. Ask <b>why grain is expensive</b> to see CE trace it back.",
  explained:
    "That chain came from CE's provenance graph, not a guess. <b>Fork timeline B</b> from your branch point to try a different action.",
  forked: "Two worlds now exist from the same branch point. <b>Compare</b> them.",
  compared:
    "Same seed, same engine, two different histories. Re-checkpoint at a later tick and fork again to branch from a different moment.",
};

/** How many samples the history strips retain. */
const SPARK_LEN = 24;

function fmt(value: number, places = 2): string {
  return value.toFixed(places);
}

function short(hash: string, chars = 8): string {
  return hash.slice(0, chars);
}

/**
 * A value's history as a row of proportional bars.
 *
 * Deliberately plain DOM rather than canvas: it stays legible at any zoom, needs
 * no measurement pass, and reads correctly to assistive tech via the summary
 * text alongside it.
 */
function renderSpark(host: HTMLElement, series: number[], accent: string): void {
  host.textContent = "";
  if (series.length < 2) return;

  const max = Math.max(...series);
  const min = Math.min(...series);
  const span = max - min;

  for (const value of series) {
    const bar = document.createElement("span");
    bar.className = "spark__bar";
    // A flat series should read as a flat line, not as zero-height bars.
    const ratio = span < 1e-9 ? 0.5 : (value - min) / span;
    bar.style.height = `${Math.max(8, Math.round(ratio * 100))}%`;
    bar.style.background = accent;
    host.append(bar);
  }
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
    priceNote: q("[data-note=price]"),
    priceSpark: q("[data-spark=price]"),
    stock: q("[data-stock]"),
    stockNode: q("[data-node=stock]"),
    stockNote: q("[data-note=stock]"),
    stockSpark: q("[data-spark=stock]"),
    road: q("[data-road]"),
    roadNode: q("[data-node=road]"),
    hostility: q("[data-hostility]"),
    hostilityNode: q("[data-node=hostility]"),
    hostilityNote: q("[data-note=hostility]"),
    hostilitySpark: q("[data-spark=hostility]"),
    roadEdge: q("[data-edge=road]"),
    cpState: q("[data-cp-state]"),
    log: q("[data-log]"),
    why: q("[data-why]"),
    compare: q("[data-compare]"),
    hint: q("[data-hint]"),
    btnDestroy: q<HTMLButtonElement>("[data-act=destroy]"),
    btnAdvance1: q<HTMLButtonElement>("[data-act=advance1]"),
    btnAdvance5: q<HTMLButtonElement>("[data-act=advance5]"),
    btnWhy: q<HTMLButtonElement>("[data-act=why]"),
    btnCheckpoint: q<HTMLButtonElement>("[data-act=checkpoint]"),
    btnFork: q<HTMLButtonElement>("[data-act=fork]"),
    btnCompare: q<HTMLButtonElement>("[data-act=compare]"),
    btnReset: q<HTMLButtonElement>("[data-act=reset]"),
  };

  let demo: CeDemo | null = null;
  let branch: CeDemo | null = null;
  let stage: Stage = "initial";
  let previous: WorldView | null = null;
  let forkCount = 0;

  /** The branch point, with the tick it was taken at. */
  let checkpoint: { data: string; tick: number; id: string } | null = null;

  /** Value history for the strips. */
  const series = {
    price: [] as number[],
    stock: [] as number[],
    hostility: [] as number[],
  };

  /** Peak hostility seen, so a decayed value can be shown in context. */
  let hostilityPeak = 0;

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

  function hostilityOf(view: WorldView): number {
    // CE's key is MG>player. Reading it directly is the whole fix for the
    // "hostility never changes" report.
    return view.relations[DEMO_HOSTILITY_KEY] ?? 0;
  }

  function push(target: number[], value: number): void {
    target.push(value);
    if (target.length > SPARK_LEN) target.shift();
  }

  function renderCheckpointState(): void {
    if (checkpoint === null) {
      els.cpState.textContent = "no branch point set";
      els.cpState.classList.remove("cp--set");
      return;
    }
    els.cpState.textContent = `branch point: tick ${checkpoint.tick} · ${checkpoint.id}`;
    els.cpState.classList.add("cp--set");
  }

  function render(view: WorldView, opts: { sample?: boolean; flashChanges?: boolean } = {}): void {
    const region = view.regions[DEMO_REGION];
    if (region === undefined) return;

    const price = region.prices["grain"] ?? 0;
    const stock = region.stocks["grain"] ?? 0;
    const road = region.infrastructure[DEMO_STRUCTURES.road];
    const roadIntact = road?.intact ?? false;
    const hostility = hostilityOf(view);

    if (opts.sample === true) {
      push(series.price, price);
      push(series.stock, stock);
      push(series.hostility, hostility);
      if (hostility > hostilityPeak) hostilityPeak = hostility;
    }

    els.tick.textContent = String(view.tick);
    els.hash.textContent = short(view.stateHash);
    els.timeline.textContent = view.timelineId;

    els.price.textContent = fmt(price);
    els.stock.textContent = fmt(stock, 1);
    els.road.textContent = roadIntact ? "intact" : "destroyed";
    els.hostility.textContent = fmt(hostility);

    // ── Price note: say when CE has clamped, so a capped value is legible ──
    const atCeiling = price >= DEMO_GRAIN_PRICE_CEILING - 1e-6;
    if (atCeiling) {
      els.priceNote.textContent = `at CE's ceiling (${fmt(DEMO_GRAIN_PRICE_CEILING)}) — stock exhausted`;
      els.priceNode.classList.add("node--capped");
    } else {
      const first = series.price[0];
      els.priceNote.textContent =
        first !== undefined && series.price.length > 1
          ? `Riverford market · from ${fmt(first)}`
          : "Riverford market";
      els.priceNode.classList.remove("node--capped");
    }

    // ── Stock note: empty granary is the reason the price stops moving ────
    els.stockNote.textContent =
      stock <= 1e-9 ? "granary empty — nothing left to sell" : "stored in Riverford";
    els.stockNode.classList.toggle("node--capped", stock <= 1e-9);

    // ── Hostility note: show the peak, because decay is constant ──────────
    if (hostilityPeak > 0 && hostility < hostilityPeak - 1e-9) {
      els.hostilityNote.textContent = `${DEMO_FACTION} toward player · peaked at ${fmt(hostilityPeak)}, decaying`;
    } else {
      els.hostilityNote.textContent = `${DEMO_FACTION} toward player`;
    }

    els.roadNode.classList.toggle("node--broken", !roadIntact);
    els.roadEdge.classList.toggle("edge--live", roadIntact);

    renderSpark(els.priceSpark, series.price, "var(--amber)");
    renderSpark(els.stockSpark, series.stock, "var(--cyan-600)");
    renderSpark(els.hostilitySpark, series.hostility, "var(--red-400)");

    if (opts.flashChanges === true && previous !== null) {
      const before = previous.regions[DEMO_REGION];
      const beforePrice = before?.prices["grain"] ?? price;
      const beforeStock = before?.stocks["grain"] ?? stock;
      const beforeHostility = hostilityOf(previous);

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

    log("ce", "CE accepted the intervention. Nothing has propagated yet — no time has passed.");
    render(demo.view());
    disable(els.btnDestroy);
    enable(els.btnAdvance1, els.btnAdvance5);
    setHint("acted");
  }

  function advanceBy(ticks: number): void {
    if (demo === null) return;

    log("you", `advance ${ticks} tick${ticks === 1 ? "" : "s"}`);

    // Sample every tick so the history strip shows the real shape rather than
    // only the endpoints of a jump.
    for (let i = 0; i < ticks; i += 1) {
      const view = demo.advance(1);
      render(view, { sample: true, flashChanges: i === ticks - 1 });
    }

    const events = demo.drainEvents();
    for (const event of events) {
      log(
        "ce",
        event.regionId === undefined ? event.type : `${event.type} @ ${event.regionId}`,
        event.streamSeq,
      );
    }
    if (events.length === 0) log("ce", "no events emitted");

    const view = demo.view();
    log("ce", `tick ${view.tick} · stateHash ${short(view.stateHash, 12)}`);

    const price = view.regions[DEMO_REGION]?.prices["grain"] ?? 0;
    if (price >= DEMO_GRAIN_PRICE_CEILING - 1e-6) {
      log(
        "warn",
        `price is at CE's clamp ceiling (${fmt(DEMO_GRAIN_PRICE_CEILING)}) — the granary is empty, so it cannot rise further`,
      );
    }

    enable(els.btnWhy, els.btnCheckpoint, els.btnAdvance1, els.btnAdvance5);
    if (stage === "acted" || stage === "initial" || stage === "checkpointed") setHint("advanced");
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

    log(
      "ce",
      cause.explained ? `attribution: ${cause.rootActions[0]?.action ?? "?"}` : "unexplained",
    );
    if (stage === "advanced") setHint("explained");
  }

  function onCheckpoint(): void {
    if (demo === null) return;

    const save = demo.save();
    checkpoint = { data: save.data, tick: save.tick, id: save.checkpointId };
    renderCheckpointState();

    log("you", `checkpoint at tick ${save.tick}`);
    log("ce", `branch point ${save.checkpointId} @ tick ${save.tick}`);
    enable(els.btnFork);

    // Re-checkpointing later moves the branch point, so any existing comparison
    // no longer refers to it.
    if (branch !== null) {
      log("warn", "branch point moved — fork again to branch from this tick");
      branch = null;
      els.compare.hidden = true;
      disable(els.btnCompare);
    }

    if (stage === "initial") setHint("checkpointed");
  }

  function onFork(): void {
    if (demo === null || checkpoint === null) return;

    forkCount += 1;
    const label = `B${forkCount === 1 ? "" : forkCount}`;

    log("you", `fork timeline "${label}" from tick ${checkpoint.tick}`);
    const result = demo.fork(checkpoint.data, label);

    if (!result.ok || result.demo === undefined) {
      log("err", `fork failed: ${result.errors.join("; ")}`);
      return;
    }

    branch = result.demo;
    log("ce", `timeline ${label} created at tick ${checkpoint.tick}: ${branch.timeline().timelineId}`);

    // Diverge: subsidise instead of destroying.
    log("you", `intervene grant_merchant_subsidy → ${DEMO_REGION} (timeline ${label})`);
    const acted = branch.act("grant_merchant_subsidy", DEMO_REGION, "region", DEMO_REGION);
    if (!acted.ok) {
      log("err", `CE rejected on ${label}: ${acted.errors.join("; ")}`);
      return;
    }

    const bView = branch.advance(5);
    branch.drainEvents();
    log("ce", `timeline ${label} advanced to tick ${bView.tick} · ${short(bView.stateHash, 12)}`);

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
          <div class="branch__row"><dt>tick</dt><dd>${view.tick}</dd></div>
          <div class="branch__row"><dt>grain</dt><dd>${fmt(region?.prices["grain"] ?? 0)}</dd></div>
          <div class="branch__row"><dt>stock</dt><dd>${fmt(region?.stocks["grain"] ?? 0, 1)}</dd></div>
          <div class="branch__row"><dt>road</dt><dd>${region?.infrastructure[DEMO_STRUCTURES.road]?.intact === true ? "intact" : "destroyed"}</dd></div>
          <div class="branch__row"><dt>hostility</dt><dd>${fmt(hostilityOf(view))}</dd></div>
          <div class="branch__row"><dt>stateHash</dt><dd>${short(view.stateHash)}</dd></div>
        </dl>
      </div>`;

    const verdict = comparison.stateHashEqual
      ? "Identical worlds."
      : comparison.traceHashEqual
        ? "Different worlds, same recorded history — which should not happen; please report it."
        : `Different worlds, different histories. CE reports <b>${comparison.differences.length}</b> diverging quantities.`;

    const branchTick = checkpoint?.tick ?? 0;

    els.compare.innerHTML = `
      <p class="compare__from">both branched from <b>tick ${branchTick}</b></p>
      <div class="compare__grid">
        ${side("branch--a", "Timeline A — road destroyed", a, aRegion)}
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
    forkCount = 0;
    hostilityPeak = 0;
    series.price.length = 0;
    series.stock.length = 0;
    series.hostility.length = 0;

    els.log.innerHTML = '<div class="log__empty">Awaiting your first intervention.</div>';
    els.why.hidden = true;
    els.compare.hidden = true;
    renderCheckpointState();

    for (const node of [els.priceNode, els.stockNode, els.hostilityNode]) {
      node.classList.remove("node--changed", "node--capped");
    }

    const view = demo.reset(42);
    render(view, { sample: true });
    log("ce", `world created · seed 42 · ${short(view.stateHash, 12)}`);

    disable(els.btnAdvance1, els.btnAdvance5, els.btnWhy, els.btnFork, els.btnCompare);
    enable(els.btnDestroy, els.btnCheckpoint);
    setHint("initial");
  }

  // ── Boot ────────────────────────────────────────────────────────────

  els.btnDestroy.addEventListener("click", onDestroy);
  els.btnAdvance1.addEventListener("click", () => advanceBy(1));
  els.btnAdvance5.addEventListener("click", () => advanceBy(5));
  els.btnWhy.addEventListener("click", onWhy);
  els.btnCheckpoint.addEventListener("click", onCheckpoint);
  els.btnFork.addEventListener("click", onFork);
  els.btnCompare.addEventListener("click", onCompare);
  els.btnReset.addEventListener("click", onReset);

  renderCheckpointState();

  createDemo(42)
    .then((instance) => {
      demo = instance;
      const view = instance.view();
      render(view, { sample: true });
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
