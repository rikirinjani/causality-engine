import type { CausalContribution, Intervention, RegionId, WorldState } from "../core/types.js";
import { key, record, setRef } from "../core/provenance.js";
import { WAREHOUSE_ID } from "./content.js";

/**
 * Developer-authored "causal physics": what an action may do and what pressure it exerts.
 *
 * Two-part contract, and the split is the point (docs/RECONNAISSANCE.md §4):
 *   immediateEffects      - direct, bounded state change applied NOW, so game feel never
 *                           waits on the quota.
 *   causalContributions   - pressure per (region, domain), resolved later by the quota.
 *
 * Contributions carry `pressure` (unsigned salience) and `valence` (signed direction;
 * +1 = disruptive, -1 = relieving). Opposing causes therefore raise salience while netting
 * direction, instead of cancelling each other into silence - see §16.4.
 *
 * No schema may reference another schema, and none may special-case a combination of
 * actions. Composition must emerge from shared world state, not from authored pairs.
 */
export interface ActionSchema {
  action: string;
  allowedTargets: Intervention["target"]["type"][];
  /** Applied synchronously on submit. `causeNode` is the intervention's provenance node. */
  immediateEffects(state: WorldState, intervention: Intervention, causeNode: string): { ok: boolean; errors: string[] };
  /** Computed BEFORE immediateEffects so a schema can inspect a target it is about to remove. */
  causalContributions(state: WorldState, intervention: Intervention): Array<{
    regionId: RegionId;
    contribution: CausalContribution;
  }>;
}

/** All structures share destruction semantics: disable, and destroy any stored contents. */
function destroyStructureEverywhere(
  state: WorldState,
  structureId: string,
  intervention: Intervention,
  causeNode: string,
): void {
  for (const regionId of Object.keys(state.regions).sort()) {
    const region = state.regions[regionId];
    const structure = region?.infrastructure[structureId];
    if (!region || !structure) continue;

    structure.health = 0;
    const effect = record(state, {
      tick: state.tick,
      kind: "effect",
      label: `${structure.type}_destroyed`,
      regionId,
      detail: { structureId, action: intervention.action },
      parents: [causeNode],
    });
    setRef(state, key.infra(regionId, structureId), effect);

    // Stored goods are lost with the structure. Generic property of destruction -
    // not a warehouse special case.
    if (structure.reserve !== undefined && structure.reserve > 0) {
      const lost = structure.reserve;
      structure.reserve = 0;
      const reserveNode = record(state, {
        tick: state.tick,
        kind: "effect",
        label: "stored_reserve_lost",
        regionId,
        value: lost,
        detail: { structureId, resource: structure.resource ?? "unknown" },
        parents: [effect],
      });
      setRef(state, `${regionId}:reserve:${structureId}`, reserveNode);
    }

    // A destroyed trade route blocks flow at both endpoints.
    if (structure.type === "trade_route") {
      setRef(state, key.tradeBlocked(regionId), effect);
    }
  }
}

export const ACTION_SCHEMAS: Record<string, ActionSchema> = {
  /**
   * Destroy a structure (bridge/route, warehouse, shrine...).
   * Contributions depend on the STRUCTURE TYPE, not on the structure's id, so adding
   * content never requires touching the engine.
   */
  destroy_infrastructure: {
    action: "destroy_infrastructure",
    allowedTargets: ["infrastructure"],
    immediateEffects(state, i, causeNode) {
      const region = state.regions[i.location];
      if (!region) return { ok: false, errors: [`unknown region ${i.location}`] };
      const structure = region.infrastructure[i.target.id];
      if (!structure) return { ok: false, errors: [`infrastructure ${i.target.id} not found in ${i.location}`] };
      if (structure.health <= 0) return { ok: false, errors: [`infrastructure ${i.target.id} already destroyed`] };
      destroyStructureEverywhere(state, i.target.id, i, causeNode);
      return { ok: true, errors: [] };
    },
    causalContributions(state, i) {
      const region = state.regions[i.location];
      const structure = region?.infrastructure[i.target.id];
      if (!structure) return [];
      const out: Array<{ regionId: RegionId; contribution: CausalContribution }> = [];

      switch (structure.type) {
        case "trade_route":
          // Both endpoints lose the link: economic + food-supply + merchant-trust pressure.
          for (const endpoint of [...structure.endpoints].sort()) {
            out.push({ regionId: endpoint, contribution: { domain: "economy", pressure: 1.0, valence: +1, scope: "regional" } });
            out.push({ regionId: endpoint, contribution: { domain: "ecology", pressure: 0.8, valence: +1, scope: "regional" } });
            out.push({ regionId: endpoint, contribution: { domain: "faction", pressure: 0.5, valence: +1, scope: "regional" } });
          }
          break;
        case "storage":
          // Losing a buffer is a local food-supply shock with mild economic weight.
          out.push({ regionId: i.location, contribution: { domain: "ecology", pressure: 0.7, valence: +1, scope: "regional" } });
          out.push({ regionId: i.location, contribution: { domain: "economy", pressure: 0.4, valence: +1, scope: "regional" } });
          break;
        case "shrine":
          // Purely civic. NO economic or ecological pressure - Experiment F depends on this.
          out.push({ regionId: i.location, contribution: { domain: "civic", pressure: 1.0, valence: +1, scope: "regional" } });
          break;
        default:
          out.push({ regionId: i.location, contribution: { domain: "civic", pressure: 0.3, valence: +1, scope: "regional" } });
      }
      return out;
    },
  },

  kill_entity: {
    action: "kill_entity",
    allowedTargets: ["entity"],
    immediateEffects(state, i, causeNode) {
      const target = state.entities[i.target.id];
      if (!target) return { ok: false, errors: [`entity ${i.target.id} not found`] };
      if (target.location !== i.location) return { ok: false, errors: [`entity ${i.target.id} not in ${i.location}`] };

      const region = state.regions[i.location];
      if (region) region.population = region.population.filter((eid) => eid !== target.id);
      delete state.entities[target.id];

      const effect = record(state, {
        tick: state.tick,
        kind: "effect",
        label: "entity_removed",
        regionId: i.location,
        detail: { entityId: target.id, role: target.role, factionId: target.factionId ?? "" },
        parents: [causeNode],
      });
      setRef(state, key.population(i.location), effect);
      return { ok: true, errors: [] };
    },
    causalContributions(state, i) {
      const target = state.entities[i.target.id];
      const out: Array<{ regionId: RegionId; contribution: CausalContribution }> = [
        { regionId: i.location, contribution: { domain: "faction", pressure: 0.3, valence: +1, scope: "regional" } },
      ];
      if (target && target.role === "merchant") {
        out.push({ regionId: i.location, contribution: { domain: "economy", pressure: 0.2, valence: +1, scope: "regional" } });
      }
      // A killing is also a civic event - visible unrest, independent of economics.
      out.push({ regionId: i.location, contribution: { domain: "civic", pressure: 0.4, valence: +1, scope: "regional" } });
      return out;
    },
  },

  /**
   * A purely civic action with no economic pathway at all (Experiment F).
   * Deliberately has NO immediate state effect: it exists to prove that civic pressure
   * resolves into civic consequences only.
   */
  hold_public_rally: {
    action: "hold_public_rally",
    allowedTargets: ["region"],
    immediateEffects(state, i, causeNode) {
      const region = state.regions[i.target.id];
      if (!region) return { ok: false, errors: [`unknown region ${i.target.id}`] };
      if (i.target.id !== i.location) return { ok: false, errors: [`rally target must equal location`] };
      record(state, {
        tick: state.tick,
        kind: "effect",
        label: "rally_held",
        regionId: i.location,
        detail: { action: i.action },
        parents: [causeNode],
      });
      return { ok: true, errors: [] };
    },
    causalContributions(state, i) {
      return [{ regionId: i.location, contribution: { domain: "civic", pressure: 1.0, valence: +1, scope: "regional" } }];
    },
  },

  /**
   * A merchant subsidy: the COMPETING CAUSE (feedback brief section 4).
   *
   * Deliberately the mirror image of destroying the granary - it pushes the same domains in
   * the OPPOSITE direction (relieving valence) through the same generic machinery. It
   * restocks the granary reserve and supports trade investment.
   *
   * Nothing here knows that a destruction action exists. Whatever happens when both land in
   * the same epoch is produced by the shared ledger and shared stock variables.
   */
  grant_merchant_subsidy: {
    action: "grant_merchant_subsidy",
    allowedTargets: ["region"],
    immediateEffects(state, i, causeNode) {
      const region = state.regions[i.target.id];
      if (!region) return { ok: false, errors: [`unknown region ${i.target.id}`] };
      if (i.target.id !== i.location) return { ok: false, errors: [`subsidy target must equal location`] };

      const cfg = state.config;
      const warehouse = region.infrastructure[WAREHOUSE_ID];
      // Restock a surviving granary. A destroyed one cannot be filled - the subsidy's
      // effect is CONDITIONAL on structure state, which is how the two actions interact
      // without either mentioning the other.
      if (warehouse && warehouse.health > 0) {
        const before = warehouse.reserve ?? 0;
        warehouse.reserve = Math.min(cfg.warehouseInitialReserve, before + cfg.subsidyReserveGrant);
        const node = record(state, {
          tick: state.tick,
          kind: "effect",
          label: "warehouse_restocked",
          regionId: i.location,
          value: warehouse.reserve,
          detail: { granted: warehouse.reserve - before },
          parents: [causeNode],
        });
        setRef(state, `${i.location}:reserve:${WAREHOUSE_ID}`, node);
      } else {
        record(state, {
          tick: state.tick,
          kind: "effect",
          label: "subsidy_had_no_store_to_fill",
          regionId: i.location,
          detail: { reason: warehouse ? "warehouse_destroyed" : "no_warehouse" },
          parents: [causeNode],
        });
      }

      // Investment support applies regardless of whether a granary exists.
      const prevInv = region.tradeInvestment;
      region.tradeInvestment = Math.min(cfg.investmentMax, prevInv + cfg.subsidyInvestmentBoost);
      const invNode = record(state, {
        tick: state.tick,
        kind: "effect",
        label: "trade_investment_subsidised",
        regionId: i.location,
        value: region.tradeInvestment,
        detail: { delta: region.tradeInvestment - prevInv },
        parents: [causeNode],
      });
      setRef(state, key.investment(i.location), invNode);

      return { ok: true, errors: [] };
    },
    causalContributions(state, i) {
      // RELIEVING direction (valence -1): the mirror image of granary destruction, expressed
      // through the same generic machinery.
      return [
        { regionId: i.location, contribution: { domain: "economy", pressure: 0.4, valence: -1, scope: "regional" } },
        { regionId: i.location, contribution: { domain: "ecology", pressure: 0.7, valence: -1, scope: "regional" } },
      ];
    },
  },
};
