# AI Flashcard Distiller for Obsidian

Distill the essence of your notes into high-value flashcards using LLMs (via the [AI Providers](https://github.com/mprojects/obsidian-ai-providers) plugin). Optimized for the [Spaced Repetition](https://github.com/stefanushinardi/obsidian-spaced-repetition) plugin.

## Features

- **High-Value Distillation**: Focused on extracting core principles, profound insights, and remarkable takeaways rather than trivial definitions.
- **Spaced Repetition Ready**: Formats output with tags and syntax (e.g., `Front :: Back`) that are 100% compatible with the **Spaced Repetition** plugin.
- **Manual Trigger**: Generate cards via a command or hotkey, keeping you in control.
- **Configurable**: 
  - Choose your preferred AI Provider (Ollama, OpenAI, Anthropic, etc.).
  - Customize the system prompt.
  - Set a custom flashcard root folder.
  - Choose your own flashcard tag (e.g., `#flashcards/`).
  - Add optional headers/watermarks to generated files.
- **Mirrored Structure**: Automatically mirrors your vault's directory structure in the flashcards folder.

## Installation

1. Install the [AI Providers](https://github.com/mprojects/obsidian-ai-providers) plugin and configure your LLM service.
2. Install this plugin (currently manual installation required).
3. Enable both plugins in Obsidian.

## Usage

1. Open a note you want to generate flashcards for.
2. Open the Command Palette (`Cmd/Ctrl + P`).
3. Search for **"Generate flashcards for active file"** and press Enter.
4. The plugin will create a new file in your configured flashcard folder with the generated cards.

### Recommended Workflow

Assign a hotkey (like `Cmd + Shift + G`) to the generation command for a frictionless experience.

## Settings

- **Flashcard folder**: The root directory for all generated flashcards.
- **Flashcard tag**: The tag added to the top of each file (default: `#flashcards/`).
- **AI Provider**: Choose which provider from the AI Providers plugin to use.
- **System prompt**: Customize the instructions given to the LLM.
- **Flashcard file header**: Optional text added to every generated file.
- **Excluded folders**: Prevent the plugin from running on specific directories.

## Development

1. Clone the repository.
2. Run `npm install` to install dependencies.
3. Run `npm run build` to compile the TypeScript code.
4. The `main.js`, `manifest.json`, and `styles.css` (if any) are the files needed by Obsidian.

## License

MIT
