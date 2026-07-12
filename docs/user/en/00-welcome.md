# 00 — Welcome and Safety

[Manual index](./README.md) | [简体中文](../zh-CN/00-welcome.md) | [Next: Windows basics →](./01-windows-basics.md)

## What You Will Accomplish

You will understand what Prism Vesicle does, what this manual expects from you, and which safety rules matter before installing anything.

**Estimated time:** 10 minutes

**Prerequisites:** None

## What Prism Vesicle Is

Prism Vesicle is a terminal application for working with Prism Engine prompts through AI model providers. You type instructions in a text interface, the selected model responds, and Vesicle can preserve conversations, ask for confirmation, use approved tools, and create project files in guarded folders.

Vesicle is the host application. It does not contain an AI model by itself. To have a real conversation, you connect it to a supported model provider with your own API key.

The default Prism engine is ETL, which helps turn source ideas and research into structured character and scenario materials. Later chapters will explain other engines and more advanced workflows.

## What Prism Vesicle Is Not

- It is not a web page or a traditional graphical desktop application.
- It is not an AI subscription and does not include model usage credits.
- It is not a general-purpose coding agent with unrestricted access to your computer.
- It cannot guarantee that model output is correct, safe, or suitable for publication.

## The Four Things You Will Set Up

1. A terminal where you can type commands.
2. Bun, the runtime used to launch Vesicle.
3. A project folder where Vesicle keeps your work.
4. A model provider configuration and API key stored in your Windows user profile.

You do not need Git, WSL, Linux, Visual Studio, or administrator access for the beginner path.

## Safety Rules

### Protect API keys

An API key is similar to a password that allows software to spend your provider account's model quota. Never paste it into chat messages, screenshots, issue reports, `providers.yaml`, or files inside your project.

This manual stores the key in `%APPDATA%\prism-vesicle\.env`. Chapter 04 will show the exact steps.

### Understand cost

Most API providers charge according to model usage. Read the provider's current pricing and billing controls before creating a key. Start with a small balance or spending limit when the provider offers one.

### Review generated files

AI output can contain factual errors, unwanted content, or structural mistakes. Preview and validate important artifacts before sharing or publishing them.

### Do not run as Administrator

The beginner instructions use your normal Windows account. If Windows Terminal says `Administrator` in its title, close it and open a normal terminal instead.

## How Commands Are Shown

Commands appear in blocks like this:

```powershell
bun --version
```

Copy only the command text, paste it into PowerShell, and press Enter. Do not type an extra `>` prompt symbol. When a block contains multiple lines, run them from top to bottom unless the text says to paste the whole block at once.

Text such as `YOUR_API_KEY` is a placeholder. Replace it with the requested value. Paths, command names, and configuration field names shown in backticks should normally be kept exactly as written.

## Completion Check

You are ready for the next chapter if you can answer these questions:

- Does Vesicle include an AI model or model credits? No.
- Where will the API key be stored? In the user-level `.env` file described later.
- Should you run the tutorial as Administrator? No.
- Are you expected to review AI-generated output? Yes.

[Next: Windows, Files, and PowerShell →](./01-windows-basics.md)
