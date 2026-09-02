## Quantity — CE quantity-key helpers for explain() requests.
##
## CE tracks causal provenance per named quantity. These helpers build the key
## strings so you never have to remember the format or risk a typo that turns a
## real explanation into "not explained".
##
## Usage:
##   ce.request_explain(Quantity.price("RF", "grain"))
##   ce.request_explain(Quantity.hostility("MG"))
##   ce.request_explain(Quantity.infra("RF", "grain_road"))
##
## These mirror CE's own key helpers exactly. This file contains no logic beyond
## string formatting — the quantities themselves are CE's, not Godot's.

class_name Quantity
extends RefCounted


## Market price of a resource in a region. -> "RF:price:grain"
static func price(region_id: String, resource: String) -> String:
	return "%s:price:%s" % [region_id, resource]


## Stored quantity of a resource in a region. -> "RF:stock:grain"
static func stock(region_id: String, resource: String) -> String:
	return "%s:stock:%s" % [region_id, resource]


## Transient price multiplier. -> "RF:priceShock:grain"
static func price_shock(region_id: String, resource: String) -> String:
	return "%s:priceShock:%s" % [region_id, resource]


## Structure health. -> "RF:infra:grain_road"
static func infra(region_id: String, structure_id: String) -> String:
	return "%s:infra:%s" % [region_id, structure_id]


## Whether trade is blocked in a region. -> "RF:tradeBlocked"
static func trade_blocked(region_id: String) -> String:
	return "%s:tradeBlocked" % region_id


## Faction hostility. -> "MG:hostility"
static func hostility(faction_id: String) -> String:
	return "%s:hostility" % faction_id


## Faction income. -> "MG:income"
static func income(faction_id: String) -> String:
	return "%s:income" % faction_id


## Civic unrest in a region. -> "RF:unrest"
static func unrest(region_id: String) -> String:
	return "%s:unrest" % region_id


## Patrol demand in a region. -> "RF:patrolDemand"
static func patrol_demand(region_id: String) -> String:
	return "%s:patrolDemand" % region_id


## Whether an entity is patrolling. -> "a13:patrolling"
static func patrolling(entity_id: String) -> String:
	return "%s:patrolling" % entity_id


## Resident population of a region. -> "RF:population"
static func population(region_id: String) -> String:
	return "%s:population" % region_id


## Merchant trade investment. -> "RF:tradeInvestment"
static func investment(region_id: String) -> String:
	return "%s:tradeInvestment" % region_id


## Merchant profitability signal. -> "RF:merchantProfitability"
static func profitability(region_id: String) -> String:
	return "%s:merchantProfitability" % region_id


## Grain production modifier. -> "RF:grainProdMod"
static func prod_mod(region_id: String) -> String:
	return "%s:grainProdMod" % region_id


## Accumulated causal pressure in a region/domain.
## Domains: "civic", "ecology", "economy", "faction". -> "RF:ledger:economy"
static func ledger(region_id: String, domain: String) -> String:
	return "%s:ledger:%s" % [region_id, domain]
