const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

const builder = t => {
    const html = fs.readFileSync('docs/index.html','utf8');
    const dom = new JSDOM(html, { runScripts:'outside-only', url:'https://fixtures.invalid/' });
    t.after(() => dom.window.close());
    const w = dom.window;
    let submit;
    const requests = [];
    w.document.getElementById('builderForm').addEventListener = (_type, handler) => { submit = handler; };
    w.google = { accounts: { oauth2: { initTokenClient: () => ({ requestAccessToken() {} }) } } };
    w.fetch = async (_url, request) => { requests.push(JSON.parse(request.body)); return { ok:true, text:async () => 'Synthetic generated script' }; };
    const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(match => match[1]).find(text => text.includes('let accessToken'));
    w.eval(script);
    w.document.getElementById('scriptUrl').value = 'https://fixtures.invalid/builder';
    w.document.getElementById('username').value = ' fixture ';
    w.document.getElementById('password').value = '  synthetic password  ';
    return { w, requests, submit: () => submit({ preventDefault() {} }), field: id => w.document.getElementById(id) };
};

test('builder transmits password whitespace exactly as entered', async t => {
    const x = builder(t);
    await x.submit();
    assert.equal(x.requests.length,1);
    assert.equal(x.requests[0].password,'  synthetic password  ');
});

test('malformed Runs JSON and invalid run shapes show errors, clear stale output and send no request', async t => {
    const x = builder(t);
    for (const runs of ['{bad','{}','[]','[null]','[{"playlistID":"42","pages":0}]','[{"playlistID":"42","pages":1,"query":42}]']) {
        x.field('runs').value = runs;
        x.field('output').textContent = 'Previous successful output';
        await assert.doesNotReject(x.submit());
        assert.match(x.field('output').textContent,/error/i);
        assert.doesNotMatch(x.field('output').textContent,/Previous successful/);
        assert.equal(x.requests.length,0);
    }
});
