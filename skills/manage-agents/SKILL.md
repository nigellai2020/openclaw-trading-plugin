---
name: manage-agents
description: List or delete trading agents. Use when the user wants to see their agents, remove an agent, or clean up old agents.
---

# Manage Trading Agents

## List agents
Call `list_my_agents`. Optional filters: `mode` ("live"/"paper"), `marketType` ("spot"/"perp"), `page`, `pageSize`.

Present results as a table: ID, name, pair, mode, market type, initial capital, current value, P&L, status.

## Billing subscriptions
If the user asks about billing subscriptions, renewal status, or next billing dates, call `get_billing_subscriptions` and summarize the active subscriptions for the current billing wallet.

## Delete an agent
1. If the user hasn't specified an agent ID, call `list_my_agents` first and ask which one to delete.
2. Confirm with the user before deleting — show the agent name and ID.
3. Call `delete_agent` with the `agentId`.
4. Report results: settlement (live only), trading-data deletion, and trading-bot deletion status.
5. If deletion partially fails, say which backend failed so the user knows whether billing cancellation or bot cleanup may still be pending.
