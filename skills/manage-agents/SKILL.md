---
name: manage-agents
description: List, update, reactivate, or delete trading agents. Use when the user wants to see their agents, change agent settings, re-enable an inactive agent, remove an agent, or clean up old agents.
---

# Manage Trading Agents

**Session constraint (strict):** All plugin tool calls in this workflow (`list_my_agents`, `get_agent`, `update_agent`, `delete_agent`) MUST be called directly from the current main session. Do NOT spawn a subagent for any step in this workflow. Do NOT use `exec`, custom scripts, or direct HTTP calls to the backend as a workaround. If a required tool is unavailable in the current tool list, stop and report a plugin or configuration issue instead of delegating.

## List agents
Call `list_my_agents`. Optional filters: `mode` (`live` or `paper`), `marketType` (`spot` or `perp`), `page`, `pageSize`.

Present results as a table: ID, name, pair, mode, market type, initial capital, current value, P&L, status.

## Update an agent
1. If the user has not specified an agent ID, call `list_my_agents` first and ask which agent to update.
2. Call `get_agent` if you need a quick public summary before confirming the change.
3. Call `update_agent` with only the fields the user explicitly wants changed. Do not infer or auto-fill missing values.
4. `chainId` can be set for both paper and live agents. It selects the execution network.
5. If the requested change touches live runtime fields (`walletAddress`, `settlementConfig`, `symbol`, `chainId`, `protocol`) and the tool reports missing companion fields, ask only for those missing companion fields before retrying.
6. For live wallet updates, prefer `walletAddress` when the user gives a single wallet. Use `settlementConfig` only when they explicitly provide both master and agent addresses.
7. Never send both `walletAddress` and `settlementConfig` in the same `update_agent` call.
8. Do not ask the user for `buyLimit` on updates. Live sizing is derived server-side. Do not ask for `initialCapital` unless the user is explicitly switching the agent from live mode to paper mode.
9. If the user wants to switch which source agent a copied agent follows, pass `copiedFromAgentId` to `update_agent`. Do not pass `isPrivate` together with `copiedFromAgentId`.
10. Report the `tradingData` result. If the tool returns `warnings`, surface them verbatim.

## Reactivate an agent
1. If the user has not specified an agent ID, call `list_my_agents` first and ask which inactive agent should be re-enabled.
2. Use the normal update flow to set the agent active again when the available toolset supports it.
3. Report whether the agent is active again and surface any backend warning verbatim.

## Delete an agent
1. If the user hasn't specified an agent ID, call `list_my_agents` first and ask which one to delete.
2. Confirm with the user before deleting. Show the agent name and ID.
3. Call `delete_agent` with the `agentId`. The server handles downstream delegation internally.
4. Report `tradingData.ok`. If it failed, say deletion may be incomplete.
