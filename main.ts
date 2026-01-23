import {
    App,
    Notice,
    Plugin,
    PluginSettingTab,
    Setting,
    TFile,
} from "obsidian";
import { initAI, waitForAI, IAIProvider, IAIProvidersService } from "@obsidian-ai-providers/sdk";

interface Settings {
    flashcardRoot: string;
    flashcardTag: string;
    selectedProviderId: string;
    systemPrompt: string;
    excludedFolders: string[];
    fileHeader: string;
}

const DEFAULT_SETTINGS: Settings = {
    flashcardRoot: "Flashcards",
    flashcardTag: "flashcards",
    selectedProviderId: "",
    systemPrompt:
        "You are a ruthless flashcard synthesizer. Your only job is to extract and distill the **most important, high-value, memorable ideas** from the provided note — nothing else.\n\n" +
        "Be extremely selective:\n" +
        "- Ignore filler, examples (unless exceptionally insightful), repetition, basic definitions, routine details.\n" +
        "- For books/articles/lectures: start with a TL;DR summary and then briefly outline the main ideas, focus on core principles, profound insights, takeaways, counterintuitive points, or annotated highlights.\n" +
        "- For journal entries create a single flashcard ONLY whenever something remarkable happened that it would be great to remember in the future.\n" +
        "- Aim for the fewest flashcards possible per note. If nothing stands out as truly valuable long-term, output nothing.\n\n" +
        "Format rules:\n" +
        "- Use 'Front :: Back' for single-line cards\n" +
        "- Use 'Front ? Back' only when the back genuinely needs multiple lines (keep it concise)\n" +
        "- Front should be clear, specific, and testable\n" +
        "- Back should be precise, correct, and self-contained\n\n" +
        "Output rules (strict):\n" +
        "- ONLY the flashcards — one per line\n" +
        "- NO introductions, conclusions, explanations, counts, comments, markdown headers, apologies, or any other text whatsoever\n" +
        "- If no content is worth extracting, output nothing (empty response)",
    excludedFolders: ["Templates"],
    fileHeader: "", // empty = no watermark/header text
};

export default class AIFlashcardDistillerPlugin extends Plugin {
    settings!: Settings;

    async onload() {
        await this.loadSettings();

        initAI(this.app, this, async () => {
            this.addSettingTab(new AIFlashcardDistillerSettingTab(this.app, this));

            this.addCommand({
                id: "generate-flashcards-active-note",
                name: "Generate flashcards for the active note",
                callback: () => {
                    const activeFile = this.app.workspace.getActiveFile();
                    if (activeFile instanceof TFile && activeFile.extension === "md") {
                        this.generateFlashcards(activeFile);
                    } else {
                        new Notice("No active note found");
                    }
                }
            });

            console.log("AI Flashcard Distiller loaded");
        });
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    private shouldSkipFile(file: TFile): boolean {
        const root = this.settings.flashcardRoot.replace(/\/$/, "");
        if (file.path.startsWith(root + "/") || file.path === root) {
            return true;
        }

        return this.settings.excludedFolders.some((folder) => {
            const clean = folder.replace(/\/$/, "");
            return file.path === clean || file.path.startsWith(clean + "/");
        });
    }

    private async generateFlashcards(file: TFile) {
        if (this.shouldSkipFile(file)) {
            new Notice("File is in an excluded folder or flashcard root");
            return;
        }

        try {
            const content = await this.app.vault.read(file);
            const tagPrefix = `#${this.settings.flashcardTag}/`;
            if (!content.trim() || content.trim().startsWith(tagPrefix)) {
                new Notice("Skipping: empty or already a flashcard note");
                return;
            }

            const ai = await this.getAIProviders();
            if (!ai) {
                new Notice("AI Providers plugin not available");
                return;
            }

            const provider = this.selectProvider(ai);
            if (!provider) {
                new Notice("No AI provider available");
                return;
            }

            new Notice(`Distilling flashcards • ${file.basename}`);

            const fullPrompt = `${this.settings.systemPrompt}\n\n${content}`;

            let accumulatedText = "";
            const result = await ai.execute({
                provider,
                prompt: fullPrompt,
                onProgress: (_chunk, total) => {
                    accumulatedText = total;
                },
            });

            const text = this.extractResponseText(result, accumulatedText);

            if (!text?.trim()) {
                console.warn("AI Flashcard Distiller: Received empty response from AI", { result, accumulatedText });
                new Notice(`Nothing distilled for ${file.basename} (empty response)`);
                return;
            }

            const clean = text.replace(/^<think>[\s\S]*?<\/think>\s*/i, "").trim();
            if (!clean) {
                new Notice(`No flashcards left after cleaning for ${file.basename}`);
                return;
            }

            await this.saveFlashcards(file, clean);
            new Notice(`Flashcards distilled • ${file.basename}`);
        } catch (err: any) {
            console.error("Flashcard distillation failed:", err);
            new Notice(`Failed to distill flashcards: ${err.message || String(err)}`);
        }
    }

    private async getAIProviders(): Promise<IAIProvidersService | null> {
        let ai = (this.app as any).aiProviders as IAIProvidersService | undefined;
        if (ai) return ai;

        try {
            const waiter = await waitForAI();
            return await waiter.promise;
        } catch {
            return null;
        }
    }

    private selectProvider(ai: IAIProvidersService): IAIProvider | null {
        if (this.settings.selectedProviderId) {
            const found = ai.providers.find((p) => p.id === this.settings.selectedProviderId);
            if (found) return found;
        }

        const mainId = (ai as any).plugin?.settings?.aiProviders?.main;
        if (mainId) {
            const found = ai.providers.find((p) => p.id === mainId);
            if (found) return found;
        }

        return ai.providers[0] ?? null;
    }

    private extractResponseText(raw: any, accumulated: string): string | null {
        if (typeof raw === "string" && raw.length > 0) return raw;
        if (accumulated?.length > 0) return accumulated;

        if (raw && typeof raw === "object") {
            const text = raw.text || raw.content || raw.message || raw.response || raw.data || raw.result;
            if (typeof text === "string") return text;

            // Fallback: Force visibility into the object
            return JSON.stringify(raw, null, 2);
        }

        return raw ? String(raw) : null;
    }

    private async saveFlashcards(original: TFile, content: string) {
        const root = this.settings.flashcardRoot.replace(/\/$/, "");
        const targetPath = `${root}/${original.path}`;
        const folderPath = targetPath.split("/").slice(0, -1).join("/");

        // Ensure folders exist recursively
        if (folderPath && !await this.app.vault.adapter.exists(folderPath)) {
            await this.app.vault.createFolder(folderPath).catch(() => { });
        }

        const tag = `#${this.settings.flashcardTag}/${original.path.replace(/\.md$/, "")}`;

        let textToSave = tag + "\n\n";
        if (this.settings.fileHeader.trim()) {
            textToSave += this.settings.fileHeader.trim() + "\n\n";
        }

        const finalContent = textToSave + content;

        const existing = this.app.vault.getAbstractFileByPath(targetPath);
        if (existing instanceof TFile) {
            await this.app.vault.modify(existing, finalContent);
        } else {
            await this.app.vault.create(targetPath, finalContent);
        }
    }
}

class AIFlashcardDistillerSettingTab extends PluginSettingTab {
    plugin: AIFlashcardDistillerPlugin;

    constructor(app: App, plugin: AIFlashcardDistillerPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    async display() {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName("Flashcard folder")
            .setDesc("Where to store generated flashcard files")
            .addText((text) =>
                text
                    .setPlaceholder("Flashcards")
                    .setValue(this.plugin.settings.flashcardRoot)
                    .onChange(async (v) => {
                        this.plugin.settings.flashcardRoot = v.trim();
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Flashcard tag")
            .setDesc("The tag used to identify flashcard files (e.g. 'flashcards' becomes '#flashcards/')")
            .addText((text) =>
                text
                    .setPlaceholder("flashcards")
                    .setValue(this.plugin.settings.flashcardTag)
                    .onChange(async (v) => {
                        this.plugin.settings.flashcardTag = v.trim().replace(/^#/, "").replace(/\/$/, "");
                        await this.plugin.saveSettings();
                    })
            );

        try {
            const waiter = await waitForAI();
            const ai = await waiter.promise;
            const options: Record<string, string> = { "": "Use default (main)" };

            ai.providers.forEach((p) => {
                options[p.id] = p.name || p.model || p.id;
            });

            new Setting(containerEl)
                .setName("AI Provider")
                .addDropdown((dd) =>
                    dd
                        .addOptions(options)
                        .setValue(this.plugin.settings.selectedProviderId)
                        .onChange(async (v) => {
                            this.plugin.settings.selectedProviderId = v;
                            await this.plugin.saveSettings();
                        })
                );
        } catch {
            new Setting(containerEl).setName("AI Provider").setDesc("AI Providers plugin not detected");
        }

        new Setting(containerEl)
            .setName("System prompt")
            .setDesc("Instructions sent to the model")
            .addTextArea((ta) =>
                ta
                    .setValue(this.plugin.settings.systemPrompt)
                    .setPlaceholder("Default prompt...")
                    .onChange(async (v) => {
                        this.plugin.settings.systemPrompt = v;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Flashcard note watermark")
            .setDesc(
                "Optional text to add at the top of each generated note (after the tag).\n" +
                "Examples: 'Generated by LLM', 'Source note', your name, date, etc.\n" +
                "Leave empty for clean notes with only the tag."
            )
            .addTextArea((ta) =>
                ta
                    .setPlaceholder("Leave blank for no watermark")
                    .setValue(this.plugin.settings.fileHeader)
                    .onChange(async (v) => {
                        this.plugin.settings.fileHeader = v;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Excluded folders")
            .setDesc("Comma-separated — e.g. Templates, Private, Journal")
            .addText((t) =>
                t
                    .setValue(this.plugin.settings.excludedFolders.join(", "))
                    .onChange(async (v) => {
                        this.plugin.settings.excludedFolders = v
                            .split(",")
                            .map((s) => s.trim())
                            .filter(Boolean);
                        await this.plugin.saveSettings();
                    })
            );
    }
}