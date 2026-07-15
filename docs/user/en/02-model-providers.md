# 02 — Model Providers, API Keys, Cost, and Privacy

[← Previous: Windows basics](./01-windows-basics.md) | [Manual index](./README.md) | [简体中文](../zh-CN/02-model-providers.md) | [Next: Installation →](./03-installation.md)

## What You Will Accomplish

You will understand the service account needed by Vesicle, create or identify an API key, and make informed decisions about cost and privacy before connecting the program.

**Estimated time:** 15–30 minutes, depending on provider registration

**Prerequisites:** Chapters 00–01 and access to a supported model provider account

## What a Model Provider Does

A model provider operates the remote AI service. Vesicle sends the conversation and permitted tool results to that service, then displays the model's response.

The current Vesicle release supports these protocol families:

- OpenAI-compatible Chat Completions
- Anthropic Messages
- Gemini `generateContent`

The beginner path uses DeepSeek because the repository's current example configuration already includes it. This is a tutorial choice, not a product endorsement or requirement. Advanced chapters will cover Anthropic, Gemini, local compatible servers, and multiple providers.

## Create a Provider Account

Open the provider's official website in your browser and create an account. For the tutorial configuration, use the [DeepSeek Platform](https://platform.deepseek.com/) and consult the [official API documentation](https://api-docs.deepseek.com/) for current model ids, API keys, and billing information.

Provider websites change independently of Vesicle, so this manual does not describe every button. Confirm that you are on the provider's real domain before entering payment details or creating a key.

## Check Pricing and Limits

Before using an API key:

1. Read the current price for the model you plan to use.
2. Check whether the account requires prepaid credit or automatic billing.
3. Set a small spending limit or alert if the provider supports it.
4. Understand that long conversations, large source files, tool loops, and reasoning models can use more tokens.

Vesicle displays usage information when the provider returns it, but the provider's billing page remains the authority for actual charges.

## Create an API Key

Use the provider dashboard to create a new API key. A key often looks like a long random sequence.

Copy it temporarily to a secure password manager or keep the provider page open until Chapter 04. Do not paste the key into this manual, a chat conversation, a screenshot, or `providers.yaml`.

If a key is accidentally exposed, revoke it in the provider dashboard and create a replacement.

## Understand What Is Sent to the Provider

During a model request, the provider may receive:

- the active Prism engine's system prompt
- the conversation context needed for the current turn
- text or images you attach
- model-visible tool definitions
- tool results returned during the turn

Vesicle keeps host-only session metadata and secret configuration out of normal provider messages, but you should still avoid submitting confidential material unless the provider and your account policy are appropriate for it.

The project-wide [Privacy Policy](../../../PRIVACY.md) separately documents local storage, model-provider transfers, optional Tavily and MCP requests, user-authorized shell/network actions, and deletion.

## Choose a Tutorial Model

The repository example currently names `deepseek-v4-flash` as the default tutorial model. Provider model catalogs can change. If the provider dashboard or API documentation no longer offers that exact id, choose a current tool-capable DeepSeek model and use its exact API model id in Chapter 04.

Do not guess a model id from a marketing name. Copy the API model id from current provider documentation.

## Completion Check

Before continuing, confirm that:

- you have a provider account
- you understand how the account is billed
- you have created an API key or know where to create it
- you know the provider Base URL; Setup will discover model ids when the provider supports `/v1/models`
- you have not placed the API key in the project folder

[Next: Install Prism Vesicle →](./03-installation.md)
