/** Feature loader: only descriptors supplied by installed plugin owners are activated. */
window.CortexUI = {
  async prepare(transport) {
    let descriptors = await transport.uiContributions();
    const mounted = new Map();
    const fragmentSlots = new Map();
    const modules = new Map();
    const lifetime = new AbortController();
    let host, apis;
    const view = { get descriptors() { return descriptors; }, onChange: null };
    const slotFor = (id, group) => {
      let slot = fragmentSlots.get(id);
      if (!slot) {
        const template = document.querySelector(`template[data-fragment="${CSS.escape(id)}"]`);
        slot = template || document.createElement('template');
        slot.dataset.fragment = id;
        slot.dataset.cortexFeature = group;
        if (!template) (document.getElementById('architecture-panels') || document.querySelector('#architecture-screen .architecture-page') || document.body).append(slot);
        fragmentSlots.set(id, slot);
      }
      return slot;
    };
    const mountMarkup = descriptor => {
      const elements = [];
      for (const fragment of descriptor.fragments || []) {
        const slot = slotFor(fragment.id, descriptor.id);
        const template = document.createElement('template');
        template.innerHTML = fragment.html;
        const children = [...template.content.childNodes];
        slot.after(template.content);
        elements.push(...children);
      }
      if (descriptor.styles) {
        const style = document.createElement('style'); style.textContent = descriptor.styles; document.head.append(style); elements.push(style);
      }
      if (descriptor.view && !document.querySelector(`[data-architecture-view="${CSS.escape(descriptor.view)}"]`)) {
        const button = document.createElement('button'); button.className = 'architecture-nav-btn'; button.dataset.architectureView = descriptor.view; button.textContent = descriptor.title;
        document.getElementById('architecture-list')?.append(button); elements.push(button);
      }
      if(descriptor.view&&!document.querySelector('[data-architecture-tab="'+CSS.escape(descriptor.view)+'"]')){
        const tab=document.createElement('button');tab.className='architecture-tab';tab.type='button';tab.id='architecture-tab-'+descriptor.view;tab.dataset.architectureTab=descriptor.view;tab.setAttribute('role','tab');tab.setAttribute('aria-selected','false');tab.setAttribute('aria-controls','architecture-panel-'+descriptor.view);tab.tabIndex=-1;tab.textContent=descriptor.title;
        document.querySelector('.architecture-tabs')?.append(tab);elements.push(tab);
      }
      if(descriptor.view){const panel=document.querySelector('[data-architecture-panel="'+CSS.escape(descriptor.view)+'"]');panel?.setAttribute('aria-labelledby','architecture-tab-'+descriptor.view);}
      return elements;
    };
    const syncVisibility = () => {
      const views = new Set(descriptors.map(d => d.view).filter(Boolean));
      for (const element of document.querySelectorAll('[data-architecture-view], [data-architecture-tab]')) {
        element.hidden = !views.has(element.dataset.architectureView || element.dataset.architectureTab);
      }
      for (const [id, section] of [['files', 'files'], ['runtime', 'plugins'], ['skills', 'skills']]) {
        const element = document.querySelector(`[data-section="${section}"]`);
        if (element) element.hidden = !descriptors.some(d => d.id === id);
      }
    };
    const signature = descriptor => JSON.stringify(descriptor);
    const activate = item => {
      item.controller = new AbortController();
      const boundTransport = Object.create(transport);
      boundTransport.callTool = (name, input, options = {}) => transport.callTool(name, input, {
        ...options, signal: AbortSignal.any([item.controller.signal, lifetime.signal, ...(options.signal ? [options.signal] : [])]),
      });
      const boundHost = new Proxy(host, { get(target, key) { return key === 'transport' ? boundTransport : key === 'callTool' ? boundTransport.callTool : Reflect.get(target, key); } });
      return item.factory(boundHost);
    };
    const dispose = item => {
      item.controller?.abort();
      item.api?.dispose?.();
    };
    async function load(descriptor) {
      let factory = modules.get(descriptor.moduleSource);
      if (!factory) {
        const url = URL.createObjectURL(new Blob([descriptor.moduleSource], { type: 'text/javascript' }));
        try { factory = (await import(url)).createFeature; } finally { URL.revokeObjectURL(url); }
        if (typeof factory !== 'function') throw new Error('Invalid UI contribution: ' + descriptor.id);
        modules.set(descriptor.moduleSource, factory);
      }
      return factory;
    }
    for (const descriptor of descriptors) mounted.set(descriptor.id, { descriptor, elements: mountMarkup(descriptor), factory: await load(descriptor) });
    syncVisibility();
    view.bind = async (bridge, featureApis) => {
      host = bridge; apis = featureApis;
      window.CortexUI.features = apis;
      for (const [id, fallback] of Object.entries(window.cortexFeatureFallbacks)) apis[id] = fallback(host);
      for (const [id, item] of mounted) apis[id] = item.api = activate(item);
      for (const item of mounted.values()) item.api.mount?.();
      let queue = Promise.resolve();
      const refresh = async () => {
        const next = await transport.uiContributions();
        for (const [id, item] of mounted) {
          const replacement = next.find(d => d.id === id);
          if (replacement && signature(replacement) === signature(item.descriptor)) continue;
          dispose(item); for (const element of item.elements) element.remove(); mounted.delete(id);
          apis[id] = window.cortexFeatureFallbacks[id]?.(host) || {};
        }
        const added = [];
        for (const descriptor of next) if (!mounted.has(descriptor.id)) {
          const factory = await load(descriptor), elements = mountMarkup(descriptor);
          const item = { descriptor, elements, factory };
          item.api = activate(item);
          mounted.set(descriptor.id, item); apis[descriptor.id] = item.api; added.push(item.api);
        }
        descriptors = next; syncVisibility(); view.onChange?.(); for (const api of added) api.mount?.();
      };
      if (transport.pluginEvents) void (async () => {
        for await (const _event of transport.pluginEvents(lifetime.signal)) queue = queue.then(refresh).catch(error => { if (!lifetime.signal.aborted) console.error('UI contribution refresh failed', error); });
      })().catch(error => { if (!lifetime.signal.aborted) console.error(error); });
      window.addEventListener('pagehide', () => { lifetime.abort(); for (const item of mounted.values()) dispose(item); }, { once: true });
    };
    return view;
  },
};
