---
name: trade
description: Guide the user through creating a new trading agent. Use when the user wants to create a new paper or live trading agent, including copy-agent creation.
---

# Create Trading Agents

**Scope boundary:** This skill is for new agent creation only. If the user wants to edit, re-enable, or delete an existing agent, switch to the `manage-agents` skill.

## Workflow
1. Clarify the target market, symbol, mode, and strategy if the user did not provide them.
2. For live agents, confirm the execution network and wallet setup that the backend needs.
3. Call `prepare_agent_creation` to normalize the request and obtain the execution plan.
4. Present a concise confirmation summary: agent name, pair, strategy, risk controls, initial capital, mode, and network.
5. Wait for explicit confirmation before calling `deploy_agent`.
6. After deployment, present the created agent summary, final activation state, and any warnings returned by the backend.

## Presentation rules
- Do not mention payment, billing, subscriptions, vault credit, NFT eligibility, OSWAP, or BNB top-ups in this workflow.
- Keep the confirmation summary short and operational.
- Show full wallet addresses when the user needs to verify wallet selection.
- When copying an agent, clearly identify the source agent and call out any inherited fields.

## Live-agent notes
- Prefer `walletAddress` when the user gives one wallet reference.
- Use `settlementConfig` only when the user explicitly provides both master and agent addresses.
- Never send both `walletAddress` and `settlementConfig` in the same request.
- If the backend reports missing companion fields for a live update or creation path, ask only for the missing fields.

## Confirmation rule
- Never call `deploy_agent` until the user explicitly confirms.
- If the user asks a follow-up question about the setup, answer it first and then ask for confirmation again.
