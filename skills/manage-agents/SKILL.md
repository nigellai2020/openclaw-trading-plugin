---
name: manage-agents
description: List, update, renew billing for, or delete trading agents. Use when the user wants to see their agents, change agent settings, top up billing before expiry, remove an agent, or clean up old agents.
---

# Manage Trading Agents

**Session constraint (strict):** All plugin tool calls in this workflow (`list_my_agents`, `get_billing_subscriptions`, `prepare_agent_billing_renewal`, `renew_agent_billing`, `get_agent`, `update_agent`, `delete_agent`) MUST be called directly from the current main session. Do NOT spawn a subagent for any step in this workflow. Do NOT use `exec`, custom scripts, or direct HTTP calls to the backend as a workaround. If a required tool is unavailable in the current tool list, stop and report a plugin or configuration issue instead of delegating.

## List agents
Call `list_my_agents`. Optional filters: `mode` ("live"/"paper"), `marketType` ("spot"/"perp"), `page`, `pageSize`.

Present results as a table: ID, name, pair, mode, market type, initial capital, current value, P&L, status.

## Billing subscriptions
If the user asks about billing subscriptions, renewal status, or next billing dates, call `get_billing_subscriptions` and summarize the active subscriptions for the current billing wallet.

## Renew billing before expiry
1. If the user has not specified an agent ID, call `list_my_agents` first and ask which agent needs a billing top-up.
2. Call `prepare_agent_billing_renewal` with the `agentId`. This is a read-only preflight. Do not call `renew_agent_billing` in the same turn as the preflight.
3. Present the result in plain language. Always show the full billing wallet address when the user needs to fund it. Never abbreviate `0x...`.
4. If `fees.oswapShortfall > 0`, instruct the user to send only the missing `funding.bnbShortfall` amount of BNB to the billing wallet. Do not ask the user to source OSWAP separately unless they explicitly ask for the manual path.
5. If `funding.bnbShortfall = 0`, tell the user the billing wallet is already funded and ask for explicit confirmation before continuing.
6. Wait for an explicit reply such as `done`, `confirm`, or `proceed` after funding. The original renewal request does not count as confirmation.
7. Call `renew_agent_billing` with the same `agentId`.
8. Report the result as a billing-renewal receipt: wallet used, swap/approval/deposit transaction results, updated vault credit, and next billing date estimate. Include any warning returned in `billing.result.warning`.

## Update an agent
1. If the user has not specified an agent ID, call `list_my_agents` first and ask which agent to update.
2. Call `get_agent` if you need a quick public summary before confirming the change.
3. Call `update_agent` with only the fields the user explicitly wants changed. Do not infer or auto-fill missing values.
4. `chainId` can be set for both paper and live agents — it selects the network (Hyperliquid 998/999 or EVM chain ID).
5. If the requested change touches live runtime fields (`walletAddress`, `settlementConfig`, `symbol`, `chainId`, `protocol`) and the tool reports missing companion fields, ask the user only for the missing companion fields before retrying.
6. For live wallet updates, prefer `walletAddress` (mapped to API `wallet_address`) when the user gives a single wallet. Use `settlementConfig` only when they explicitly provide both master+agent addresses.
7. Never send both `walletAddress` and `settlementConfig` in the same `update_agent` call.
8. Do not ask the user for `buyLimit` on updates. Live sizing is derived server-side. Do not ask for `initialCapital` unless the user is explicitly switching the agent from live mode to paper mode.
9. **Copied agents — switching source:** If the user wants to switch which source agent a copied agent follows, pass `copiedFromAgentId` to `update_agent`. Do not pass `isPrivate` together with `copiedFromAgentId` (copied agents are always private).
10. Report the `tradingData` result. If the tool returns `warnings`, surface them verbatim.

## Delete an agent
1. If the user hasn't specified an agent ID, call `list_my_agents` first and ask which one to delete.
2. Confirm with the user before deleting — show the agent name and ID.
3. Call `delete_agent` with the `agentId`. The server handles all delegation (trading-bot and settlement) internally.
4. Report `tradingData.ok`. If it failed, say deletion may be incomplete.
