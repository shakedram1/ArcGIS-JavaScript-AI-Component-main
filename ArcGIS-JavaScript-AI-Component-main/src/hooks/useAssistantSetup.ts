import { useCallback, useEffect, useRef, useState } from "react";
import { getCredential, generateAndSaveWebMapEmbeddings, getWebMapEmbeddingsStatus } from "../utils/arcgisOnline";
import {
  refreshMcpAgentDescription,
  registerMcpPassthroughAgent,
} from "../agents/McpPassthroughAgent";
import { registerCreateFeatureLayerAgent } from "../agents/CreateFeatureLayerAgent";
import { registerManageFeatureLayerAgent } from "../agents/ManageFeatureLayerAgent";
import { registerFeatureLayerCapabilitiesAgent } from "../agents/AllCapabilitiesAgent";
import { registerAddLayerToMapAgent } from "../agents/AddLayerToMapAgent";
import { registerPlanAgent } from "../agents/PlanAgent";
import { registerTa5500MapAgent } from "../agents/Ta5500MapAgent";
import { registerScopeAgent } from "../agents/ScopeAgent";
import { excludeServerTools } from "../agents/mcpAgentCore";
import { clearMcpCaches, listMcpTools } from "../utils/mcpClient";

// data-agent-id values of the agents registered only in TA5500 mode. Their
// elements are removed when TA5500 mode ends so they never linger on another map.
const TA5500_AGENT_IDS = ["ta5500-plan", "ta5500-map", "ta5500-scope"] as const;

function removeAgentElements(assistant: HTMLElement, agentIds: readonly string[]): void {
  for (const id of agentIds) {
    assistant.querySelector(`[data-agent-id="${id}"]`)?.remove();
  }
}

interface AgentRegistration {
  id: string;
  enabled: boolean;
  register: (assistant: HTMLElement) => void;
}

function toAssistantPreparationErrorMessage(message: string): string {
  if (/eligible layers or fields|generate embeddings|embedding/i.test(message)) {
    return "למפה הזו אין עדיין נתונים נתמכים להגדרת העוזר.";
  }
  return message.replace(/embeddings?/gi, "assistant data");
}

export interface AssistantSetupState {
  isAssistantPrepared: boolean;
  isEmbeddingBusy: boolean;
  embeddingsStatusMessage: string | null;
  embeddingsError: string | null;
  showEmbeddingRegenerateButton: boolean;
  setShowEmbeddingRegenerateButton: React.Dispatch<React.SetStateAction<boolean>>;
  ensureEmbeddings: (forceRegenerate?: boolean) => Promise<void>;
  mcpHubRefreshToken: number;
  refreshMcpHub: () => void;
}

export function useAssistantSetup(
  webMapId: string,
  isMapReady: boolean,
  mapHasOperationalData: boolean,
  mapLoadError: string | null,
  isSignedIn: boolean,
  oauthClientId: string | undefined,
  portalUrl: string,
  mcpBaseUrl: string,
  isTa5500: boolean,
): AssistantSetupState {
  const [isAssistantPrepared, setIsAssistantPrepared] = useState(false);
  const [isEmbeddingBusy, setIsEmbeddingBusy] = useState(false);
  const [embeddingsStatusMessage, setEmbeddingsStatusMessage] = useState<string | null>(null);
  const [embeddingsError, setEmbeddingsError] = useState<string | null>(null);
  const [showEmbeddingRegenerateButton, setShowEmbeddingRegenerateButton] = useState(false);
  const [mcpHubRefreshToken, setMcpHubRefreshToken] = useState(0);

  const autoCheckedMapIdRef = useRef<string | null>(null);

  const refreshMcpHub = useCallback(() => {
    setMcpHubRefreshToken((v) => v + 1);
  }, []);

  // Reset assistant state when webMapId changes
  useEffect(() => {
    setIsAssistantPrepared(false);
    setEmbeddingsStatusMessage(null);
    setEmbeddingsError(null);
    autoCheckedMapIdRef.current = null;
  }, [webMapId]);

  // Register all custom agents on the assistant element when map is ready
  useEffect(() => {
    if (!webMapId || !isMapReady) return;
    const assistant = document.querySelector("arcgis-assistant") as HTMLElement | null;
    if (!assistant) return;
    let disposed = false;

    // One list, one flag per agent (spec §7): any agent can be switched off
    // in TA5500 mode by changing its `enabled` expression.
    const registrations: AgentRegistration[] = [
      { id: "create-feature-layer-agent", enabled: true, register: (a) => registerCreateFeatureLayerAgent(a, { oauthClientId, portalUrl, layerName: "Locations" }) },
      { id: "manage-feature-layer-agent", enabled: true, register: registerManageFeatureLayerAgent },
      { id: "add-layer-to-map-agent", enabled: true, register: registerAddLayerToMapAgent },
      { id: "all-capabilities-agent", enabled: true, register: registerFeatureLayerCapabilitiesAgent },
      { id: "mcp-passthrough-agent", enabled: !isTa5500, register: (a) => registerMcpPassthroughAgent(a, { baseUrl: mcpBaseUrl, serverName: "MCP Hub", ta5500Mode: false }) },
      { id: "ta5500-plan", enabled: isTa5500, register: (a) => registerPlanAgent(a, { baseUrl: mcpBaseUrl }) },
      { id: "ta5500-map", enabled: isTa5500, register: (a) => registerTa5500MapAgent(a, { baseUrl: mcpBaseUrl }) },
      { id: "ta5500-scope", enabled: isTa5500, register: registerScopeAgent },
    ];

    for (const entry of registrations) {
      // Each register function replaces its own stale [data-agent-id] element;
      // a disabled entry must not leave an earlier element behind.
      if (entry.enabled) entry.register(assistant);
      else removeAgentElements(assistant, [entry.id]);
    }
    if (registrations.some((r) => r.id === "mcp-passthrough-agent" && r.enabled)) {
      void refreshMcpAgentDescription(assistant);
    }
    if (isTa5500) {
      void (async () => {
        try {
          clearMcpCaches(mcpBaseUrl);
          const tools = await listMcpTools(mcpBaseUrl);
          if (disposed || !excludeServerTools(tools, ["ta5500"]).length) return;
        } catch (error) {
          if (disposed) return;
          console.warn("MCP tool discovery failed:", error);
        }
        registerMcpPassthroughAgent(assistant, { baseUrl: mcpBaseUrl, serverName: "MCP Hub", ta5500Mode: true });
        void refreshMcpAgentDescription(assistant);
      })();
    }

    return () => {
      disposed = true;
      if (isTa5500) removeAgentElements(assistant, TA5500_AGENT_IDS);
    };
  }, [webMapId, isMapReady, mcpHubRefreshToken, oauthClientId, portalUrl, mcpBaseUrl, isTa5500]);

  const ensureEmbeddings = useCallback(
    async (forceRegenerate = false) => {
      if (!webMapId || !mapHasOperationalData) {
        setIsEmbeddingBusy(false);
        setIsAssistantPrepared(false);
        setEmbeddingsStatusMessage(null);
        setEmbeddingsError(null);
        return;
      }

      setEmbeddingsError(null);
      setIsAssistantPrepared(false);
      setIsEmbeddingBusy(true);

      try {
        const cred = await getCredential(oauthClientId, portalUrl);

        if (!forceRegenerate) {
          setEmbeddingsStatusMessage("מכין את העוזר עבור המפה הזו...");
          const status = await getWebMapEmbeddingsStatus(portalUrl, cred.token, webMapId);
          if (status.exists) {
            setIsAssistantPrepared(true);
            setEmbeddingsStatusMessage("העוזר מוכן עבור המפה הזו.");
            autoCheckedMapIdRef.current = webMapId;
            return;
          }
        }

        setEmbeddingsStatusMessage(
          forceRegenerate
            ? "מרענן את נתוני העוזר עבור המפה הזו..."
            : "מכין את נתוני העוזר עבור המפה הזו...",
        );

        const result = await generateAndSaveWebMapEmbeddings({
          portalUrl,
          token: cred.token,
          webMapItemId: webMapId,
          removeExisting: true,
        });

        if (!result.success) throw new Error(result.message || "יצירת נתוני העוזר נכשלה.");

        setIsAssistantPrepared(true);
        setEmbeddingsStatusMessage("העוזר מוכן עבור המפה הזו.");
        autoCheckedMapIdRef.current = webMapId;
      } catch (error: unknown) {
        setIsAssistantPrepared(false);
        const raw = error instanceof Error ? error.message : "לא ניתן להכין את העוזר עבור המפה הזו.";
        setEmbeddingsError(toAssistantPreparationErrorMessage(raw));
        setEmbeddingsStatusMessage(null);
      } finally {
        setIsEmbeddingBusy(false);
      }
    },
    [webMapId, mapHasOperationalData, oauthClientId, portalUrl],
  );

  // Auto-trigger embedding check when the map is ready with data
  useEffect(() => {
    if (!isSignedIn || !webMapId || !isMapReady || mapLoadError || !mapHasOperationalData) return;
    if (autoCheckedMapIdRef.current === webMapId) return;
    void ensureEmbeddings(false);
  }, [webMapId, ensureEmbeddings, isMapReady, isSignedIn, mapHasOperationalData, mapLoadError]);

  return {
    isAssistantPrepared,
    isEmbeddingBusy,
    embeddingsStatusMessage,
    embeddingsError,
    showEmbeddingRegenerateButton,
    setShowEmbeddingRegenerateButton,
    ensureEmbeddings,
    mcpHubRefreshToken,
    refreshMcpHub,
  };
}
