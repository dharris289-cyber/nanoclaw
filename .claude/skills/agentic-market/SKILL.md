---
name: agentic-market
description: Search for paid services on Agentic Market and call them via Agentic Wallet (x402 payments). Use when Max wants to find or use a paid API service.
---

# Agentic Market — Paid Services via Agentic Wallet

Agentic Market is a directory of paid services your agent can use. Agentic Wallet (by Coinbase) handles x402 payments so Claude can call services like video generation, image generation, LinkedIn data, premium search, and more.

## Setup (CLI — Claude Code environment)

1. **Check status first:** `npx awal status`. If signed in and ready, skip to Discovery.
2. **Install if needed:** `npx skills add coinbase/agentic-wallet-skills`
3. **Sign in:**
   ```bash
   npx awal auth login <email>
   # user receives a 6-digit code
   npx awal auth verify <flowId> <otp>
   npx awal status   # confirm
   ```
4. **Fund if balance is zero:** `npx awal show` opens the wallet UI (Coinbase Onramp, QR, or address deposit). Then `npx awal balance` to verify USDC arrived. Default network is Base; pass `--chain base-sepolia|solana|solana-devnet|polygon` to switch.

## Discovery

Search for services:
```bash
curl -sS "https://api.agentic.market/v1/services/search?q=<query>"
curl -sS "https://api.agentic.market/v1/services/"
npx awal x402 bazaar search <query>
```

## Calling a Paid Service

```bash
npx awal x402 pay <endpoint-url>
```

## Service Schema

`GET https://api.agentic.market/v1/services` and `GET https://api.agentic.market/v1/services/search?q=<query>` return:

```json
{
  "services": [
    {
      "id": "...",
      "name": "Exa",
      "description": "AI-powered web search + content retrieval",
      "domain": "exa.ai",
      "category": "Search",
      "networks": ["base"],
      "endpoints": [
        {
          "url": "https://api.exa.ai/search",
          "description": "Search the web and return ranked results",
          "method": "POST",
          "pricing": { "amount": "0.007", "currency": "USDC", "network": "base" }
        }
      ]
    }
  ]
}
```

Filter by `category` (Search, Inference, Data, Media, Infra) and `networks`. Use `endpoints[].pricing.amount` to compare cost. Pass `endpoints[].url` to `npx awal x402 pay <url>`.

## Common Issues

| Symptom | Cause | Fix |
|---|---|---|
| `npx awal status` says not signed in | Sign-in incomplete | `npx awal auth login <email>` → verify OTP |
| Paid call returns 402 | Not enough USDC on right network | Open wallet, add funds, verify service network |
| Search returns empty | Query too narrow | Broaden keyword; try category names |
| Endpoint rejects payload | Wrong body shape | Re-read `endpoints[].description` before retrying |

## References

- CDP docs: https://docs.cdp.coinbase.com/llms.txt
- Full Agentic Market agent guide: https://agentic.market/llms.txt
