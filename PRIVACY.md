# Privacy Policy

[English](./PRIVACY.md) | [简体中文](./PRIVACY.zh-CN.md)

Last updated: 2026-07-21

## Summary

Prism Vesicle is a locally run, open-source terminal application. The Prism Vesicle project does not operate a telemetry, analytics, advertising, crash-reporting, account, or content-upload service. The application stores its working data on the user's computer and connects to external services only when the user configures or invokes features that require them.

Those external services have their own terms, retention rules, and privacy policies. Users should not process confidential, personal, or regulated material unless their selected services and account agreements are appropriate for it.

## Data Stored Locally

Depending on the features used, Prism Vesicle can store:

- provider, model, Tavily, MCP, permission, and asset settings in the user configuration directory, including API keys in the sibling `.env` secret file;
- conversations, model responses, tool records, usage metadata, gates, and engine transitions under the active project's `.vesicle/sessions/` directory;
- attached image copies under `.vesicle/attachments/`;
- file rewind history under `.vesicle/file-history/`;
- bounded background-process output and status under `.vesicle/processes/`;
- SubAgent state and delivery records as part of local session state;
- imported source material and generated project files under the project directories selected by the user.

The default user configuration directory is `%APPDATA%\prism-vesicle` on Windows, `$XDG_CONFIG_HOME/prism-vesicle` when `XDG_CONFIG_HOME` is set, or `~/.config/prism-vesicle` otherwise. Environment variables can override some configuration paths.

The project maintainer does not receive this local data merely because Prism Vesicle is installed or run.

## Data Sent To Model Providers

When the user starts a model request, Prism Vesicle sends data to the provider and endpoint selected in the user's configuration. Depending on the request and active model capabilities, this can include:

- the active engine's system prompt and model-visible tool definitions;
- the current conversation context and user prompt;
- images deliberately attached to the conversation;
- relevant tool results and generated context needed to continue the turn;
- generation settings and ordinary protocol metadata.

Guided Setup may send the configured API key to the selected provider and call its `/models` endpoint to discover available model ids. The key is used to authenticate the selected service. Provider-specific privacy, logging, training, residency, and retention terms apply.

## Optional External Services

### Tavily

When Tavily is configured and the user or an approved model action invokes a web tool, Tavily receives the search query, URL, crawl/map request, or research request required for that operation, along with authentication and ordinary request metadata. Tavily is not contacted merely because its key is stored.

### MCP Servers

When an MCP server is enabled, Prism Vesicle can send initialization requests, tool-list requests, configured HTTP headers, tool names, and tool arguments to that server. A server receives tool calls only when its tools are invoked, but Setup and diagnostics may connect to test or enumerate it. The server operator's privacy policy applies. Configured headers can contain credentials expanded from the local `.env` file.

### User-Authorized Commands And URLs

`shell_exec` runs approved commands on the local computer and is not a Prism-hosted service. A command, script, or program approved by the user or allowed by the selected permission mode can independently read data or access the network. Similarly, URLs fetched through web tools disclose the ordinary connection information and requested URL to the destination site and relevant service provider.

## Secrets

API keys and header secrets are intended to remain in the user-level `.env` file or process environment. They are not intentionally written to sessions or project configuration files. A secret is transmitted when needed to authenticate the external service the user explicitly configured. Prism Vesicle cannot control logging or retention performed by that external service.

Users should never paste secrets into prompts, screenshots, issues, logs, or tracked project files. A disclosed key should be revoked at its provider and replaced.

## Installation And Uninstallation

The Windows installer installs program files for the current user, adds the installation directory to that user's `PATH`, creates Start Menu entries, registers Explorer directory actions, and registers an uninstaller. Repair or upgrade can restore or replace those components.

Ordinary uninstall removes the installed program files and Windows integrations owned by the installer. It intentionally preserves the user configuration directory, credentials, local project directories, generated content, and `.vesicle/` project state so that uninstalling or upgrading does not destroy user work.

## User Control And Deletion

Users control which providers and optional services are configured, which project is opened, which tools are approved, and what content is submitted. To stop future external transfers, disable or remove the relevant provider, Tavily, or MCP configuration and revoke its credentials at the service provider.

To delete local data after closing Prism Vesicle:

- delete the applicable project's `.vesicle/` directory to remove Vesicle session, attachment, history, process, and SubAgent state for that project;
- delete generated or imported project files that are no longer wanted;
- delete the Prism Vesicle user configuration directory to remove saved provider, MCP, permission, asset, and secret configuration;
- use the external service's own account tools or support process for data already transmitted to it.

Deleting `.vesicle/`, generated files, or the user configuration directory is irreversible unless the user has a separate backup.

## Changes And Questions

Material changes to this policy will be committed publicly and recorded in the project history. Questions that do not contain personal data, credentials, private provider URLs, or confidential content may be opened in the project's [GitHub issues](https://github.com/3aKHP/prism-vesicle/issues).

For release integrity and signed-file handling, see the [Code Signing Policy](./CODE_SIGNING_POLICY.md).
