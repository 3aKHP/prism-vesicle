# 04 — Configure Your First Provider

[← Previous: Installation](./03-installation.md) | [Manual index](./README.md) | [简体中文](../zh-CN/04-first-provider.md) | [Next: Doctor and launch →](./05-doctor-and-launch.md)

## What You Will Accomplish

You will connect an OpenAI-compatible provider, select the models Vesicle should offer, optionally configure Tavily and MCP, choose a safe permission preference, and create the first project without editing YAML.

**Estimated time:** 5–10 minutes

**Prerequisites:** Chapter 03, a provider Base URL, and its API key

## Begin Setup

With **Begin guided setup** highlighted, press Enter.

## Enter the Provider Base URL

Enter the provider's API Base URL. Examples include:

```text
https://api.deepseek.com/v1
http://127.0.0.1:11434/v1
```

Setup adds `/v1` when you enter only an HTTPS origin such as `https://api.example.com`. Remote providers require HTTPS; local loopback services may use HTTP.

## Enter the API Key

Paste the provider API key and press Enter. The field is masked. The key remains in memory during model discovery and is not saved until the final review page.

Setup requests `GET <Base URL>/models` with Bearer authentication. If the provider accepts the address and key, the next page displays the returned model ids.

If discovery fails, Setup lets you retry, edit the Base URL, or continue by entering an exact model id manually. A provider that does not implement `/v1/models` therefore does not block configuration.

## Select Models

Use Up and Down to move through the model list and Space to toggle a checkbox. Press `A` to add an exact model id that was not returned by the provider. Press Enter after at least one model is selected.

Choose one selected model as the default on the next page. Model discovery reports ids only; Vesicle does not guess vision, reasoning, or context-limit capabilities from a model name.

## Optional Tavily

Choose **Skip for now** or **Configure Tavily**. Tavily enables Vesicle's web research tools. When enabled, paste the Tavily API key into the masked field. It is stored only in the user-level secret file.

Skipping Tavily does not affect ordinary provider conversations.

## Optional MCP

Choose **Skip for now** or **Add an MCP server**. The MCP flow asks for:

- a short server name;
- its Streamable HTTP URL;
- no authentication, a Bearer token, or a custom authentication header;
- a masked token when authentication is required;
- the Prism Engines that may receive its tools.

Setup initializes the server and requests its tool list. A successful result shows the discovered tool count. If the test fails, return to edit or retry; saving the failed server requires an explicit **Save server anyway** choice. Additional servers can be added before continuing.

MCP secrets are stored in the user-level `.env`. `mcp.yaml` contains only environment-variable references, not the secret value.

## Choose Permissions

For the first run, keep **Recommended**. It maps to Vesicle's MOMENTUM mode: routine workspace work can proceed, while `shell_exec` stays disabled. The other choices ask for more approvals. Setup never saves YOLO.

## Choose the First Project

Keep the suggested folder under Documents or enter another folder. Setup creates it when configuration is saved. Prism Vesicle starts in this project instead of the installation directory.

## Review and Save

The review page displays the provider address, selected/default models, whether Tavily is configured, MCP server count, permission mode, and project directory. It never displays secrets.

Select **Save configuration**. Existing supported configuration is merged, and every changed existing file receives a timestamped backup. After validation succeeds, select **Launch Prism Vesicle**.

## Completion Check

You are ready when Setup reports **Setup complete** and offers **Launch Prism Vesicle**.

[Next: Run Doctor and Launch Vesicle →](./05-doctor-and-launch.md)
