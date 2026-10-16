import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

/**
 * A settings view sizes itself through `panel.setHeight`: the host cannot measure a
 * sandboxed iframe, so without the delegate a long view is clipped inside a fixed box
 * and scrolls internally. The provider-settings surface already honoured it; this
 * surface ignored it.
 */

type HostApi = { setHeight?: (height: number) => void };
const captured: HostApi[] = [];

const realReactI18nextModule = { ...(await import("react-i18next")) };
const realDockPanelModule = { ...(await import("../plugins/PluginDockPanel")) };
mock.module("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));
mock.module("../plugins/PluginDockPanel", () => ({
	...realDockPanelModule,
	PluginDockPanelView: ({ hostApi }: { hostApi: HostApi }) => {
		captured.push(hostApi);
		return <div data-testid="view" />;
	},
}));
mock.module("../plugins/registry", () => ({
	syncPluginUiContributions: () => Promise.resolve(0),
	resolvePluginUiContribution: () => undefined,
	invalidatePluginUiContributions: () => {},
	applyPluginUiContributionItems: () => {},
}));

const { pluginContributionStore } = await import("../plugins");
const { PluginSettingsSurfacePanel } = await import("./PluginSettingsSurfacePanel");

let root: Root | undefined;
let container: HTMLDivElement | undefined;

beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	Object.assign(globalThis, {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
		IS_REACT_ACT_ENVIRONMENT: true,
	});
	captured.length = 0;
	pluginContributionStore.clear();
	pluginContributionStore.applySnapshot([
		{
			pluginId: "com.example.demo",
			contributionId: "panel",
			version: "1.0.0",
			hash: "a".repeat(64),
			title: "Panel",
			entryPath: "ui/panel.js",
			scope: "global",
			surfaces: ["settings"],
			status: "available",
		},
	]);
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(async () => {
	if (root) await act(async () => root?.unmount());
	container?.remove();
});

afterAll(() => {
	mock.module("react-i18next", () => realReactI18nextModule);
	mock.module("../plugins/PluginDockPanel", () => realDockPanelModule);
	mock.restore();
});

function frameHeight(): string {
	const view = container?.querySelector('[data-testid="view"]');
	return (view?.parentElement as HTMLElement | undefined)?.style.height ?? "";
}

describe("PluginSettingsSurfacePanel height", () => {
	test("starts at the default box and follows the view's reported height", async () => {
		await act(async () => {
			root?.render(
				<MantineProvider>
					<PluginSettingsSurfacePanel pluginId="com.example.demo" />
				</MantineProvider>,
			);
		});
		expect(frameHeight()).toBe("520px");
		const hostApi = captured.at(-1);
		expect(typeof hostApi?.setHeight).toBe("function");
		await act(async () => hostApi?.setHeight?.(940));
		expect(frameHeight()).toBe("940px");
		await act(async () => hostApi?.setHeight?.(300));
		expect(frameHeight()).toBe("300px");
	});
});
