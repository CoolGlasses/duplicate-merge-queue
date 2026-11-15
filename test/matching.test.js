'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { scoreContactPair, scoreCompanyPair, findDuplicates, PROPOSE_THRESHOLD, CAUTION_THRESHOLD } = require('../src/matching');
const { contact, company } = require('./fixtures');

const signals = (r) => r.reasons.map((x) => x.signal);

test('fixture: exact-email duplicate proposes a merge, fully explained', () => {
  const a = contact(1, { firstname: 'Maria', lastname: 'Garcia', email: 'maria@acme.com', phone: '5550101111' });
  const b = contact(2, { firstname: 'Maria', lastname: 'Garcia', email: 'maria@acme.com' });
  const r = scoreContactPair(a, b);
  assert.ok(r.score >= PROPOSE_THRESHOLD, `score ${r.score}`);
  assert.equal(r.caution, false);
  assert.ok(signals(r).includes('email_exact'));
  // Explanations must account for the score (score = sum of points, capped at 100).
  assert.equal(Math.min(100, r.reasons.reduce((s, x) => s + x.points, 0)), r.score);
  for (const reason of r.reasons) {
    assert.ok(reason.detail.length > 0);
    assert.ok(reason.points > 0);
  }
});

test('fixture: Jon/John nickname variant + shared phone proposes a merge', () => {
  const a = contact(1, { firstname: 'Jon', lastname: 'Smith', email: 'jon.smith@acme.com', phone: '+1 555 010 2233' });
  const b = contact(2, { firstname: 'John', lastname: 'Smith', email: 'john.smith@acme.com', phone: '5550102233' });
  const r = scoreContactPair(a, b);
  assert.ok(r.score >= PROPOSE_THRESHOLD, `score ${r.score}`);
  assert.ok(signals(r).includes('name_variant'));
  assert.ok(signals(r).includes('phone_exact'));
});

test('fixture: typo email (1 edit, same domain) + same name is proposed WITH caution', () => {
  // Identical full name + a 1-edit email typo is a real proposal, but two
  // distinct people can share a name at one company — so this lands in the
  // caution band (name 30 + typo 34 = 64), not the auto-propose band.
  const a = contact(1, { firstname: 'Priya', lastname: 'Nair', email: 'priya.nair@acme.com' });
  const b = contact(2, { firstname: 'Priya', lastname: 'Nair', email: 'priya.nairr@acme.com' });
  const r = scoreContactPair(a, b);
  assert.ok(r.score >= CAUTION_THRESHOLD && r.score < PROPOSE_THRESHOLD, `score ${r.score}`);
  assert.equal(r.caution, true);
  assert.ok(signals(r).includes('email_typo'));
  // Add a shared phone and the same pair clears the propose threshold.
  const a2 = contact(1, { firstname: 'Priya', lastname: 'Nair', email: 'priya.nair@acme.com', phone: '5550107777' });
  const b2 = contact(2, { firstname: 'Priya', lastname: 'Nair', email: 'priya.nairr@acme.com', phone: '(555) 010-7777' });
  assert.ok(scoreContactPair(a2, b2).score >= PROPOSE_THRESHOLD);
});

test('fixture: gmail dot/plus variants score as the same mailbox', () => {
  const a = contact(1, { firstname: 'Tom', lastname: 'Reed', email: 'tom.reed@gmail.com' });
  const b = contact(2, { firstname: 'Tom', lastname: 'Reed', email: 'tomreed+work@gmail.com' });
  const r = scoreContactPair(a, b);
  assert.ok(signals(r).includes('email_canonical'));
  assert.ok(r.score >= CAUTION_THRESHOLD, `score ${r.score}`);
});

test('fixture: same phone, different people — signal noted but NOT proposed', () => {
  const a = contact(1, { firstname: 'Alice', lastname: 'Nguyen', email: 'alice@acme.com', phone: '5550109999' });
  const b = contact(2, { firstname: 'Carlos', lastname: 'Reyes', email: 'carlos@globex.com', phone: '(555) 010-9999' });
  const r = scoreContactPair(a, b);
  assert.ok(signals(r).includes('phone_exact'));
  assert.ok(r.score < CAUTION_THRESHOLD, `shared phone alone must not propose a merge, got ${r.score}`);
});

test('fixture: company domain match — with name proposes, domain alone cautions', () => {
  const a = company(1, { name: 'Acme Widgets Inc', domain: 'acme-widgets.com' });
  const b = company(2, { name: 'Acme Widgets Inc', domain: 'www.acme-widgets.com' });
  const r = scoreCompanyPair(a, b);
  assert.ok(r.score >= PROPOSE_THRESHOLD, `score ${r.score}`);
  assert.ok(signals(r).includes('domain_exact'));

  const c = company(3, { name: 'Totally Different Name LLC', domain: 'acme-widgets.com' });
  const r2 = scoreCompanyPair(a, c);
  assert.ok(r2.score >= CAUTION_THRESHOLD && r2.score < PROPOSE_THRESHOLD, `domain alone should caution, got ${r2.score}`);
  assert.equal(r2.caution, true);
});

test('fixture: clear NON-duplicates score below the caution threshold', () => {
  const a = contact(1, { firstname: 'David', lastname: 'Kim', email: 'david.kim@acme.com', phone: '5550100001' });
  const b = contact(2, { firstname: 'Sarah', lastname: 'Connor', email: 'sarah@umbrella.org', phone: '5550100002' });
  const r = scoreContactPair(a, b);
  assert.ok(r.score < CAUTION_THRESHOLD, `score ${r.score}`);
  assert.equal(r.score, 0);

  // Same first name only is not a duplicate either.
  const c = contact(3, { firstname: 'David', lastname: 'Park', email: 'dpark@other.io', phone: '5557778888' });
  const r2 = scoreContactPair(a, c);
  assert.ok(r2.score < CAUTION_THRESHOLD, `score ${r2.score}`);
});

test('findDuplicates: finds the pair in a crowd, sorted, no sub-threshold noise', () => {
  const records = [
    contact(1, { firstname: 'Jon', lastname: 'Smith', email: 'jon.smith@acme.com', phone: '5550102233' }),
    contact(2, { firstname: 'John', lastname: 'Smith', email: 'john.smith@acme.com', phone: '+1 (555) 010-2233' }),
    contact(3, { firstname: 'Unrelated', lastname: 'Person', email: 'u@elsewhere.net', phone: '5559990000' }),
    contact(4, { firstname: 'Another', lastname: 'Human', email: 'a@sample.org', phone: '5558881111' }),
  ];
  const pairs = findDuplicates(records, 'contacts');
  assert.equal(pairs.length, 1);
  assert.deepEqual([pairs[0].aId, pairs[0].bId], ['1', '2']);
  assert.ok(pairs[0].score >= PROPOSE_THRESHOLD);
});

test('findDuplicates: companies by domain', () => {
  const records = [
    company(1, { name: 'Acme Inc', domain: 'acme.com' }),
    company(2, { name: 'Acme', domain: 'https://acme.com' }),
    company(3, { name: 'Globex', domain: 'globex.com' }),
  ];
  const pairs = findDuplicates(records, 'companies');
  assert.equal(pairs.length, 1);
  assert.deepEqual([pairs[0].aId, pairs[0].bId], ['1', '2']);
});
