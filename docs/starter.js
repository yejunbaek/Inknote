/* The notebook a first-time visitor lands in. Only used by the web build, and
 * only when the browser has nothing stored yet — it is never written over an
 * existing notebook. */
window.INKNOTE_STARTER = function () {
  const PURPLE = '#7a4bd4';

  return {
    version: 2,
    variables: [
      { id: 'v-type', name: 'Type' },
      { id: 'v-power', name: 'Power' },
      { id: 'v-accuracy', name: 'Accuracy' }
    ],
    recentLinks: [],
    sections: [{
      id: 'sec-demo', name: 'Welcome', color: PURPLE,
      pages: [
        {
          id: 'pg-start', title: 'Start here', strokes: [], links: [],
          items: [
            { id: 'w1', type: 'card', x: 60, y: 60, w: 340, color: PURPLE,
              text: 'Welcome to InkNote.\n\nEverything here is saved in your own browser — no account, and nothing is uploaded anywhere.' },
            { id: 'w2', type: 'card', x: 60, y: 230, w: 340, color: null,
              text: 'Try it:\n• Press C and click to drop a card\n• Press P and draw anywhere\n• Press L for a column, R for a row\n• Ctrl+click to select several boxes\n• Press Home if you get lost' },
            { id: 'w3', type: 'checklist', x: 440, y: 60, w: 300, color: '#1f8a52',
              rows: [
                { id: 'r1', text: 'Drag this card around', done: false },
                { id: 'r2', text: 'Double-click text to edit it', done: false },
                { id: 'r3', text: 'Right-click a box for more', done: false }
              ] },
            { id: 'w4', type: 'card', x: 440, y: 250, w: 300, color: null,
              text: 'The desktop version is the same app with local files instead of browser storage. Export from the sidebar to move a notebook between them.' }
          ]
        },
        {
          id: 'pg-board', title: 'Example board', strokes: [], links: [],
          items: [
            { id: 'b-row', type: 'row', x: 60, y: 60, title: 'Moves' },

            { id: 'b-c1', type: 'column', parent: 'b-row', order: 0, x: 0, y: 0, w: 300, title: 'Aqua Fang' },
            { id: 'b-c1f1', type: 'field', parent: 'b-c1', order: 0, x: 0, y: 0, w: 300, varId: 'v-type', value: '' },
            { id: 'b-c1lk', type: 'link', parent: 'b-c1f1', order: 0, x: 0, y: 0, w: 240,
              target: 'pg-types', anchor: 'ty-water', label: null },
            { id: 'b-c1f2', type: 'field', parent: 'b-c1', order: 1, x: 0, y: 0, w: 300, varId: 'v-power', value: '4' },
            { id: 'b-c1f3', type: 'field', parent: 'b-c1', order: 2, x: 0, y: 0, w: 300, varId: 'v-accuracy', value: '85' },

            { id: 'b-c2', type: 'column', parent: 'b-row', order: 1, x: 0, y: 0, w: 300, title: 'Ember' },
            { id: 'b-c2f1', type: 'field', parent: 'b-c2', order: 0, x: 0, y: 0, w: 300, varId: 'v-type', value: '' },
            { id: 'b-c2lk', type: 'link', parent: 'b-c2f1', order: 0, x: 0, y: 0, w: 240,
              target: 'pg-types', anchor: 'ty-fire', label: null },
            { id: 'b-c2f2', type: 'field', parent: 'b-c2', order: 1, x: 0, y: 0, w: 300, varId: 'v-power', value: '7' },
            { id: 'b-c2f3', type: 'field', parent: 'b-c2', order: 2, x: 0, y: 0, w: 300, varId: 'v-accuracy', value: '80' },

            { id: 'b-note', type: 'card', x: 60, y: 420, w: 380, color: null,
              text: 'The purple boxes are links. Click the ↗ on one to jump to the box it points at.' }
          ]
        },
        {
          id: 'pg-types', title: 'Types', strokes: [], links: [],
          items: [
            { id: 'ty-water', type: 'card', x: 60, y: 60, w: 260, color: '#1f5fd0', text: 'Water' },
            { id: 'ty-fire', type: 'card', x: 60, y: 180, w: 260, color: '#c8402f', text: 'Fire' },
            { id: 'ty-grass', type: 'card', x: 60, y: 300, w: 260, color: '#1f8a52', text: 'Grass' }
          ]
        }
      ]
    }],
    activeSectionId: 'sec-demo',
    activePageId: 'pg-start'
  };
};
