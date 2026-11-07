const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');

const fixture = (options = {}) => {
    const properties = new Map(Object.entries(options.properties || { username: 'fixture', password: ' fixture password ', cookie: JSON.stringify({ BMSESSIONID: 'synthetic' }) }));
    const members = new Set(options.members || ['old','keep']);
    const calls = [], triggers = [];
    let failLogin = options.failLogin || false, failTrigger = false, logins = 0, locks = 0;
    const response = (body, status = 200, headers = {}) => ({ getResponseCode: () => status, getContentText: () => typeof body === 'string' ? body : JSON.stringify(body), getAllHeaders: () => headers });
    const context = {
        Logger: { log: () => {} }, Utilities: { sleep: () => {} },
        LockService: { getScriptLock: () => ({ waitLock: () => locks++, releaseLock: () => locks-- }) },
        PropertiesService: { getScriptProperties: () => ({
            getProperty: key => properties.get(key) || null,
            setProperty: (key,value) => { if (options.failRecovery && key.startsWith('smokeSyncPending:')) throw new Error('synthetic property quota'); return properties.set(key,String(value)); },
            setProperties: values => Object.entries(values).forEach(([key,value]) => properties.set(key,String(value))),
            deleteProperty: key => properties.delete(key)
        }) },
        ScriptApp: { getProjectTriggers: () => triggers, newTrigger: handler => ({ timeBased: () => ({ everyDays: days => ({ create: () => {
            assert.equal(days,7); if (failTrigger) throw new Error('synthetic trigger failure');
            triggers.push({ getHandlerFunction: () => handler });
        } }) }) }) },
        UrlFetchApp: { fetch: (url, request = {}) => {
            if (url === 'https://beatsaver.com/login') {
                logins++;
                if (failLogin) throw new Error('synthetic login failure');
                return response('',302,{ 'Set-Cookie': 'BMSESSIONID=synthetic; Expires=Fri, 01 Jan 2100 00:00:00 GMT; Path=/' });
            }
            if (url.includes('/search/text/')) {
                const page = Number(/text\/(\d+)/.exec(url)[1]); calls.push(`search:${page}`);
                if (options.failSearch === page) return response({},503);
                return response(options.malformedSearch ? {} : { docs: (options.pages?.[page] || [{ id: 'keep' },{ id: 'new' }]) });
            }
            if (url === 'https://api.beatsaver.com/playlists/id/42') return response({ playlist: { downloadURL: 'https://fixtures.invalid/playlist.json' } });
            if (url === 'https://fixtures.invalid/playlist.json') return response({ songs: [...members].map(key => ({ key })) });
            if (url.includes('/api/playlists/id/')) {
                const body = JSON.parse(request.payload);
                calls.push(`${body.inPlaylist ? 'add' : 'remove'}:${body.mapId}`);
                assert.equal(url, 'https://beatsaver.com/api/playlists/id/42/add');
                if (body.inPlaylist && options.failAdd === body.mapId) return response({ success: false, error: 'synthetic rejection' });
                if (!body.inPlaylist && options.failRemove === body.mapId) return response({ success: false });
                if (body.inPlaylist) members.add(body.mapId); else members.delete(body.mapId);
                return response({ success: true });
            }
            throw new Error('Unmocked request blocked');
        } }
    };
    vm.createContext(context);
    const script = fs.readFileSync('template.js','utf8').replace(/\bSETNAME\b/g, '"fixture"').replace(/\bSETPASS\b/g, '" fixture password "').replace(/\bSETRUN\b/g, 'runwithArgs("42",1);');
    vm.runInContext(script, context);
    context.CONFIG.PLAYLIST_ID = '42';
    context.CONFIG.BMSESSIONID = 'synthetic';
    return { context, properties, members, calls, triggers, logins: () => logins, locks: () => locks, setLoginFailure: value => failLogin=value, setTriggerFailure: value => failTrigger=value };
};

test('failed replacement discovery, including later pages or malformed results, leaves every original song untouched', () => {
    for (const options of [{ failSearch: 0 },{ failSearch: 1 },{ malformedSearch: true }]) {
        const x = fixture(options);
        assert.throws(() => x.context.runwithArgs('42',2));
        assert.deepEqual([...x.members], ['old','keep']);
        assert.equal(x.calls.some(call => call.startsWith('add:') || call.startsWith('remove:')), false);
        assert.equal(x.locks(), 0);
    }
});

test('playlist URL normalization is shared by additions/removals and desired maps are added before obsolete removals', () => {
    const x = fixture();
    x.context.runwithArgs('https://beatsaver.com/playlists/42',1);
    assert.deepEqual([...x.members].sort(), ['keep','new']);
    assert.ok(x.calls.indexOf('add:new') < x.calls.indexOf('remove:old'));
    assert.equal(x.calls.includes('remove:keep'), false);
    assert.equal(x.properties.has('smokeSyncPending:42'), false);
    const invalid = fixture();
    assert.throws(() => invalid.context.runwithArgs('not-a-playlist',1));
    assert.equal(invalid.calls.length, 0);
});

test('HTTP 200 application-level addition failures are reported and preserve original members and recovery state', () => {
    const x = fixture({ failAdd: 'new' });
    const result = x.context.addToPlaylist('new');
    assert.equal(result.ok, false);
    assert.equal(result.status, 200);
    assert.match(result.body, /synthetic rejection/);
    assert.throws(() => x.context.runwithArgs('42',1), /add/i);
    assert.deepEqual([...x.members], ['old','keep']);
    assert.equal(x.calls.some(call => call.startsWith('remove:')), false);
    assert.ok(x.properties.has('smokeSyncPending:42'));
});

test('failed first login persists no initialized credentials and the next run retries safely', () => {
    const x = fixture({ properties: {}, failLogin: true });
    assert.throws(() => x.context.run(), /login/);
    assert.equal(x.properties.has('password'), false);
    assert.equal(x.properties.has('cookie'), false);
    x.setLoginFailure(false);
    x.context.run();
    assert.equal(x.logins(), 2);
    assert.equal(x.triggers.length, 1);
});

test('legacy missing/corrupt cookies and interrupted trigger setup recover without duplicate triggers', () => {
    for (const cookie of [undefined,'not-json',JSON.stringify({}),JSON.stringify({ BMSESSIONID: 'old', Expires: 'invalid-date' })]) {
        const props = { username:'fixture', password:' fixture password ' };
        if (cookie !== undefined) props.cookie = cookie;
        const x = fixture({ properties: props });
        x.setTriggerFailure(true);
        assert.throws(() => x.context.run(), /trigger/);
        x.setTriggerFailure(false);
        x.context.run();
        x.context.run();
        assert.equal(x.logins(), 1);
        assert.equal(x.triggers.length, 1);
    }
});

test('empty targets and unavailable recovery storage fail before mutating membership', () => {
    for (const options of [{ pages:[[]] },{ failRecovery:true }]) {
        const x = fixture(options);
        assert.throws(() => x.context.runwithArgs('42',1));
        assert.deepEqual([...x.members], ['old','keep']);
        assert.equal(x.calls.some(call => call.startsWith('add:') || call.startsWith('remove:')), false);
        assert.equal(x.locks(),0);
    }
});

test('partial removal failures retain the first recovery snapshot until a successful retry', () => {
    const options = { members:['old','extra','keep'], failRemove:'extra' };
    const x = fixture(options);
    assert.throws(() => x.context.runwithArgs('42',1), /remove/);
    assert.deepEqual([...x.members].sort(), ['extra','keep','new']);
    const first = JSON.parse(x.properties.get('smokeSyncPending:42')).before;
    assert.deepEqual(first, ['old','extra','keep']);
    assert.throws(() => x.context.runwithArgs('42',1), /remove/);
    assert.deepEqual(JSON.parse(x.properties.get('smokeSyncPending:42')).before, first);
    options.failRemove = undefined;
    x.context.runwithArgs('42',1);
    assert.deepEqual([...x.members].sort(), ['keep','new']);
    assert.equal(x.properties.has('smokeSyncPending:42'), false);
});
