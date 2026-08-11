# AI Provider Configuration

This document outlines the production AI provider configuration for the Abu AI Software Factory.

## Production Provider

The current production AI provider is the **Google Gemini API**, accessed via its **OpenAI-compatible endpoint**.

### Model Selection

Automated planning, repository analysis, code generation, repair, and QA/security agent tasks use:

- **Model**: `gemini-3.5-flash`

Sandbox verification runs deterministic install, typecheck, test, and build commands inside an isolated environment.

### Connection Details

The system communicates with Google Gemini through its standard OpenAI-compatible API gateway. This compatibility allows seamless integration with the existing OpenAI/agent SDK footprint.

## Secrets and Security

All credentials, API keys, and private configuration settings are strictly secured:

- **Storage**: Secrets are securely stored in **Vercel Environment Variables** and are never committed to the source code repository.
- **Access Control**: Runtime components access these values at execution time in Vercel's secure environment.
- **No Secret Leakage**: No real secret values (such as API keys or system tokens) are allowed in configuration files, documentation, or client-exposed headers.
