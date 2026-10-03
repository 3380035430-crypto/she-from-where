function contextNode(node) {
  return {
    stage: node.stage,
    text: node.text,
    incomingAction: node.incomingAction,
    fixedFacts: node.fixedFacts,
    events: node.events,
  };
}

function nodeForAction(nodes, stage, action) {
  return nodes.find((node) => node.stage === stage && node.incomingAction === action) || null;
}

export function createStateManager() {
  function base(task, story, extra = {}) {
    return {
      schemaVersion: 1,
      task,
      character: story.character,
      category: story.category,
      scenario: story.scenario || undefined,
      expectation: story.expectation || undefined,
      ...extra,
    };
  }

  function inputFor(task, story, extra = {}) {
    const requestedRoute = extra.routeContext;
    const routeContext = requestedRoute
      ? requestedRoute.map((node) => (node.stage ? contextNode(node) : node))
      : [];
    return base(task, story, { ...extra, routeContext });
  }

  function routeContext(story, action1, action2, endingNodeId = '') {
    const opening = story.nodes?.find((node) => node.stage === 'opening');
    const middle = nodeForAction(story.nodes || [], 'middle', action1);
    const ending = endingNodeId
      ? story.nodes?.find((node) => node.id === endingNodeId)
      : action2
        ? (story.nodes || []).find((node) => node.stage === 'ending' && node.parentId === middle?.id && node.incomingAction === action2)
        : null;
    return [opening, middle, ending].filter(Boolean).map(contextNode);
  }

  function routeFor(story, routeId, action1, action2) {
    return story.routes?.find((route) => route.id === routeId || (route.action1 === action1 && route.action2 === action2)) || null;
  }

  return { inputFor, routeContext, routeFor, contextNode };
}
