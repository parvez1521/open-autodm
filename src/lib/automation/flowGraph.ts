/**
 * Canonical flow graph helpers — ported from release-prep
 * src/lib/automation/flowGraph.ts (Phase 5, row 19), adapted to the
 * candidate:
 *
 *  - validateFlowGraph / automationToFlowGraph / flowGraphToAutomation /
 *    hasComplexBranches are ported. The visual-builder-only helpers
 *    (flowGraphToFlowData, getGraphAutoLayout) are NOT ported — the
 *    candidate has no visual builder (see Phase 5 report).
 *  - AI node-data fields (publicReplyMode / aiRuntimeModeEnabled /
 *    aiRuntimeInstructions — rows 9–11, not restored) are not mapped by the
 *    converters. They survive untouched inside stored graph JSON because
 *    the converters spread existing node data; the engine never reads them.
 */

import type {
  FlowGraph,
  FlowNode,
  FlowEdge,
  FlowNodeData,
  AutomationRow,
  DMResponse,
  CardButton,
} from '@/lib/types';

/**
 * Validates a canonical Flow Graph to ensure it can be safely executed and stored.
 */
export function validateFlowGraph(graph: FlowGraph): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!graph || !Array.isArray(graph.nodes)) {
    return { valid: false, errors: ['Flow graph must contain an array of nodes'] };
  }

  const nodes = graph.nodes;
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  const nodeIds = new Set<string>();

  // 1. Unique Node IDs
  for (const node of nodes) {
    if (!node.id) {
      errors.push('All nodes must have an ID');
    } else if (nodeIds.has(node.id)) {
      errors.push(`Duplicate node ID: ${node.id}`);
    } else {
      nodeIds.add(node.id);
    }
  }

  // 2. Trigger Node Check
  const triggerNodes = nodes.filter((n) => n.type === 'trigger');
  if (triggerNodes.length === 0) {
    errors.push('Flow must have at least one Trigger node');
  } else if (triggerNodes.length > 1) {
    errors.push('Flow can only have one Trigger node');
  }

  const triggerNode = triggerNodes[0];
  if (triggerNode) {
    // Trigger node cannot have incoming edges
    const incomingToTrigger = edges.filter((e) => e.target === triggerNode.id);
    if (incomingToTrigger.length > 0) {
      errors.push('Trigger node cannot have incoming connections');
    }
  }

  // 3. Edge Integrity & Disconnected Nodes
  for (const edge of edges) {
    if (!nodeIds.has(edge.source)) {
      errors.push(`Edge references non-existent source node: ${edge.source}`);
    }
    if (!nodeIds.has(edge.target)) {
      errors.push(`Edge references non-existent target node: ${edge.target}`);
    }
    if (edge.source === edge.target) {
      errors.push(`Self-referencing cycle detected on node: ${edge.source}`);
    }
  }

  // 4. Message Content & Meta Button Limits
  for (const node of nodes) {
    if (node.type === 'send_dm') {
      const text = node.data.messageText;
      if (text !== undefined && text.trim().length === 0) {
        errors.push(`DM Node "${node.data.label || node.id}" has empty message text`);
      }
      const buttons = node.data.buttons;
      if (Array.isArray(buttons) && buttons.length > 3) {
        errors.push(
          `DM Node "${node.data.label || node.id}" exceeds Meta's limit of 3 buttons (found ${buttons.length})`
        );
      }
    } else if (node.type === 'follow_up') {
      const text = node.data.followUpText;
      if (text !== undefined && text.trim().length === 0) {
        errors.push(`Follow-up Node "${node.data.label || node.id}" has empty message text`);
      }
    } else if (node.type === 'delay') {
      const delay = node.data.delayMinutes;
      if (delay !== undefined && (typeof delay !== 'number' || delay <= 0)) {
        errors.push(`Delay Node "${node.data.label || node.id}" must have a positive delay in minutes`);
      }
    }
  }

  // 5. Cycle Detection (DFS)
  const adj = new Map<string, string[]>();
  for (const id of nodeIds) adj.set(id, []);
  for (const edge of edges) {
    if (adj.has(edge.source)) {
      adj.get(edge.source)!.push(edge.target);
    }
  }

  const visited = new Set<string>();
  const recStack = new Set<string>();
  let hasCycle = false;

  function dfs(curr: string): void {
    if (hasCycle) return;
    visited.add(curr);
    recStack.add(curr);

    const neighbors = adj.get(curr) || [];
    for (const n of neighbors) {
      if (!visited.has(n)) {
        dfs(n);
      } else if (recStack.has(n)) {
        hasCycle = true;
        errors.push(`Cycle detected in flow: ${curr} -> ${n}`);
        return;
      }
    }
    recStack.delete(curr);
  }

  for (const id of nodeIds) {
    if (!visited.has(id)) {
      dfs(id);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Converts standard automation data into a clean canonical FlowGraph representation.
 */
export function automationToFlowGraph(automation: any): FlowGraph {
  const existingGraph = automation.flow_graph || automation.flowGraph;
  if (existingGraph && typeof existingGraph === 'object' && Array.isArray(existingGraph.nodes)) {
    const existing = existingGraph as FlowGraph;
    if (existing.nodes.length > 0) {
      // Sync flat fields that might have changed in Simple Builder into existing nodes
      const trigger = existing.nodes.find((n: FlowNode) => n.type === 'trigger');
      const dm = existing.nodes.find((n: FlowNode) => n.type === 'send_dm');
      const followUp = existing.nodes.find((n: FlowNode) => n.type === 'follow_up');

      const updatedNodes = existing.nodes.map((node: FlowNode) => {
        if (node.id === trigger?.id) {
          return {
            ...node,
            data: {
              ...node.data,
              keywords: automation.keywords !== undefined ? automation.keywords : node.data.keywords,
              keywordsAnyMode: automation.keywordsAnyMode !== undefined ? automation.keywordsAnyMode : node.data.keywordsAnyMode,
              postId: automation.postId ?? automation.post_id ?? node.data.postId,
              reelId: automation.reelId ?? automation.reel_id ?? node.data.reelId,
            },
          };
        }
        if (node.id === dm?.id) {
          return {
            ...node,
            data: {
              ...node.data,
              messageText: automation.dmOpeningMessage ?? automation.dm_opening_message ?? node.data.messageText,
              messageVariations: automation.dmOpeningMessageVariations ?? automation.dm_opening_message_variations ?? node.data.messageVariations,
              buttonTitle: automation.dmOpeningMessageButtonTitle ?? automation.dm_opening_message_button_title ?? node.data.buttonTitle,
              buttons: automation.dmResponses?.[0]?.buttons ?? automation.dm_responses?.[0]?.buttons ?? node.data.buttons,
            },
          };
        }
        if (node.id === followUp?.id) {
          return {
            ...node,
            data: {
              ...node.data,
              followUpText: automation.followUpMessage ?? automation.follow_up_message ?? node.data.followUpText,
            },
          };
        }
        return node;
      });

      return {
        ...existing,
        nodes: updatedNodes,
      };
    }
  }

  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];

  const typeMap: Record<string, string> = {
    'comment-dm': 'comment_dm',
    'reel-dm': 'reel_dm',
    'dm-reply': 'dm_reply',
    'story-reply': 'story_reply',
  };
  const rawType = automation.type || 'comment_dm';
  const type = typeMap[rawType] ?? rawType;
  const isAnyMode =
    automation.keywordsAnyMode ??
    (automation.trigger_config?.trigger_mode === 'any' ||
      automation.trigger_config?.keywords_any_mode === true ||
      (Array.isArray(automation.keywords) &&
        automation.keywords.some(
          (k: string) =>
            typeof k === 'string' &&
            (k.trim().toUpperCase() === '*ANY*' || k.trim().toUpperCase() === '__ANY__')
        )));

  // 1. Trigger Node
  const triggerNodeId = 'node_trigger';
  nodes.push({
    id: triggerNodeId,
    type: 'trigger',
    position: { x: 300, y: 50 },
    data: {
      label:
        type === 'comment_dm'
          ? 'Comment Trigger'
          : type === 'reel_dm'
          ? 'Shared Reel Trigger'
          : type === 'story_reply'
          ? 'Story Reply Trigger'
          : 'DM Keyword Trigger',
      triggerType: type as FlowNodeData['triggerType'],
      postId: automation.post_id ?? automation.postId ?? null,
      postThumbnailUrl: automation.post_thumbnail_url ?? automation.postThumbnailUrl ?? null,
      postCaption: automation.post_caption ?? automation.postCaption ?? '',
      keywords: isAnyMode ? [] : (automation.keywords ?? []),
      keywordsAnyMode: isAnyMode,
      reelId: automation.post_id ?? automation.postId ?? null,
      reelMatchAny: !automation.post_id && !automation.postId,
    },
  });

  // 2. First DM Node
  const dmNodeId = 'node_dm_1';
  const buttons: CardButton[] =
    automation.dm_responses?.[0]?.buttons ??
    automation.dmResponses?.[0]?.buttons ??
    (automation.dm_opening_message_button_title
      ? [{ id: 'btn_1', title: automation.dm_opening_message_button_title, link: automation.dm_opening_message_button_link || '' }]
      : []);

  nodes.push({
    id: dmNodeId,
    type: 'send_dm',
    position: { x: 300, y: 220 },
    data: {
      label: 'First Private DM',
      messageText:
        automation.dm_opening_message ||
        automation.dmOpeningMessage ||
        'Hey! Thanks for reaching out. Here is what you requested: ✨',
      messageVariations:
        automation.dm_opening_message_variations ||
        automation.dmOpeningMessageVariations ||
        [],
      buttonTitle: automation.dm_opening_message_button_title || automation.dmOpeningMessageButtonTitle || 'Get Link',
      buttons,
      publicReplyEnabled: automation.public_reply_enabled ?? automation.publicReplyEnabled ?? false,
      publicReplyOptions: automation.public_reply_options ?? automation.publicReplyOptions ?? [],
    },
  });

  edges.push({
    id: `edge_${triggerNodeId}_${dmNodeId}`,
    source: triggerNodeId,
    target: dmNodeId,
  });

  let lastNodeId = dmNodeId;
  let currentY = 380;

  // 3. Optional Condition Node (Ask to Follow)
  if (automation.ask_to_follow_enabled || automation.askToFollowEnabled) {
    const condNodeId = 'node_cond_follow';
    nodes.push({
      id: condNodeId,
      type: 'condition',
      position: { x: 300, y: currentY },
      data: {
        label: 'Require Follower?',
        conditionType: 'is_following',
        conditionValue: 'true',
      },
    });

    edges.push({
      id: `edge_${lastNodeId}_${condNodeId}`,
      source: lastNodeId,
      target: condNodeId,
    });

    lastNodeId = condNodeId;
    currentY += 160;
  }

  // 4. Optional Follow-up Flow
  if (automation.follow_up_enabled || automation.followUpEnabled) {
    const delayNodeId = 'node_delay';
    const delayMinutes = automation.follow_up_delay_minutes || automation.followUpDelayMinutes || 60;
    nodes.push({
      id: delayNodeId,
      type: 'delay',
      position: { x: 300, y: currentY },
      data: {
        label: `Wait ${delayMinutes}m`,
        delayMinutes,
      },
    });

    edges.push({
      id: `edge_${lastNodeId}_${delayNodeId}`,
      source: lastNodeId,
      target: delayNodeId,
      sourceHandle: lastNodeId.startsWith('node_cond') ? 'yes' : 'default',
    });

    lastNodeId = delayNodeId;
    currentY += 160;

    const followUpNodeId = 'node_followup';
    nodes.push({
      id: followUpNodeId,
      type: 'follow_up',
      position: { x: 300, y: currentY },
      data: {
        label: 'Follow-up Check-in',
        followUpText:
          automation.follow_up_message ||
          automation.followUpMessage ||
          'Hey {username}, did you get a chance to check the link I sent you?',
      },
    });

    edges.push({
      id: `edge_${lastNodeId}_${followUpNodeId}`,
      source: lastNodeId,
      target: followUpNodeId,
    });

    lastNodeId = followUpNodeId;
    currentY += 160;
  }

  // 5. End Node
  const endNodeId = 'node_end';
  nodes.push({
    id: endNodeId,
    type: 'end',
    position: { x: 300, y: currentY },
    data: {
      label: 'End of Flow',
    },
  });

  edges.push({
    id: `edge_${lastNodeId}_${endNodeId}`,
    source: lastNodeId,
    target: endNodeId,
  });

  return {
    version: 1,
    nodes,
    edges,
  };
}

/**
 * Extracts standard flat automation fields from a FlowGraph.
 * (AI fields from the RP version are not mapped — rows 9–11 not restored.)
 */
export function flowGraphToAutomation(graph: FlowGraph): Partial<AutomationRow> & { flow_graph: FlowGraph } {
  const triggerNode = graph.nodes.find((n) => n.type === 'trigger');
  const dmNode = graph.nodes.find((n) => n.type === 'send_dm');
  const condFollowNode = graph.nodes.find((n) => n.type === 'condition' && n.data.conditionType === 'is_following');
  const delayNode = graph.nodes.find((n) => n.type === 'delay');
  const followUpNode = graph.nodes.find((n) => n.type === 'follow_up');

  const triggerType = triggerNode?.data.triggerType || 'comment_dm';
  const isAnyMode = triggerNode?.data.keywordsAnyMode ?? false;

  const buttons: CardButton[] = dmNode?.data.buttons || [];
  const dmResponses: DMResponse[] = buttons.length > 0 || dmNode?.data.messageText
    ? [
        {
          id: 'resp_1',
          type: 'text',
          content: dmNode?.data.messageText || '',
          buttons,
        },
      ]
    : [];

  return {
    type: triggerType,
    post_id: triggerNode?.data.postId ?? triggerNode?.data.reelId ?? null,
    post_thumbnail_url: triggerNode?.data.postThumbnailUrl ?? null,
    post_caption: triggerNode?.data.postCaption ?? null,
    keywords: isAnyMode ? null : (triggerNode?.data.keywords ?? null),
    dm_opening_message_enabled: true,
    dm_opening_message: dmNode?.data.messageText || '',
    dm_opening_message_button_title: dmNode?.data.buttonTitle || null,
    dm_responses: dmResponses,
    ask_to_follow_enabled: !!condFollowNode,
    follow_up_enabled: !!followUpNode,
    follow_up_delay_minutes: delayNode?.data.delayMinutes || 60,
    follow_up_message: followUpNode?.data.followUpText || '',
    public_reply_enabled: dmNode?.data.publicReplyEnabled ?? false,
    public_reply_options: dmNode?.data.publicReplyOptions ?? [],
    flow_graph: graph,
  };
}

/**
 * Detects whether a FlowGraph contains complex or custom branching beyond
 * the standard linear automation pipeline. Used by the automations API to
 * decide whether an edit through the linear builder may regenerate the
 * graph from flat fields (simple graphs) or must preserve it verbatim
 * (complex graphs) — the same rule release-prep's builders apply.
 */
export function hasComplexBranches(graph: FlowGraph | null | undefined): boolean {
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    return false;
  }
  const standardIds = new Set([
    'node_trigger',
    'node_dm_1',
    'node_cond_follow',
    'node_delay',
    'node_followup',
    'node_end',
  ]);

  // If there are custom nodes created in visual flow canvas
  const hasCustomNodes = graph.nodes.some((n) => !standardIds.has(n.id));
  if (hasCustomNodes) return true;

  // If any node has more than 1 outgoing edge
  const outgoingCount = new Map<string, number>();
  for (const edge of graph.edges) {
    outgoingCount.set(edge.source, (outgoingCount.get(edge.source) || 0) + 1);
    if ((outgoingCount.get(edge.source) || 0) > 1) {
      return true;
    }
  }

  // If there are more than 1 condition node or more than 1 send_dm node
  const condNodes = graph.nodes.filter((n) => n.type === 'condition');
  const dmNodes = graph.nodes.filter((n) => n.type === 'send_dm');
  if (condNodes.length > 1 || dmNodes.length > 1) {
    return true;
  }

  return false;
}
