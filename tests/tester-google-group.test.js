import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { createTesterGoogleGroup } from '../src/tester-google-group.js';

test('Directory client signs delegated OAuth JWT, caches tokens, encodes group key and accepts existing member', async () => {
  const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  const env={ PLAY_TESTER_GOOGLE_CLIENT_EMAIL:'service@example.invalid',PLAY_TESTER_GOOGLE_ADMIN_EMAIL:'admin@example.invalid',
    PLAY_TESTER_GOOGLE_PRIVATE_KEY:privateKey.export({type:'pkcs8',format:'pem'}),PLAY_TESTER_GROUP_CLIENT:'testers@example.invalid' };
  const calls=[];
  const client=createTesterGoogleGroup({env,clock:()=>1800000000000,fetchImpl:async(url,options)=>{
    calls.push(url);
    if(url.includes('oauth2')) {
      const jwt=options.body.get('assertion'); const [header,body,signature]=jwt.split('.');
      assert.ok(verify('RSA-SHA256',Buffer.from(`${header}.${body}`),publicKey,Buffer.from(signature,'base64url')));
      const claims=JSON.parse(Buffer.from(body,'base64url'));
      assert.equal(claims.sub,env.PLAY_TESTER_GOOGLE_ADMIN_EMAIL);
      assert.equal(claims.scope,'https://www.googleapis.com/auth/admin.directory.group.member');
      return {ok:true,json:async()=>({access_token:'mock-access',expires_in:3600})};
    }
    assert.equal(options.headers.Authorization,'Bearer mock-access');
    assert.deepEqual(JSON.parse(options.body),{email:'tester@gmail.com',role:'MEMBER'});
    return {ok:false,status:409};
  }});
  assert.equal(client.configured('client'),true); assert.equal(client.configured('rider'),false);
  await client.addMember('client','tester@gmail.com'); await client.addMember('client','tester@gmail.com');
  assert.equal(calls.length,3);
  assert.equal(calls[1],'https://admin.googleapis.com/admin/directory/v1/groups/testers%40example.invalid/members');
});

test('no credentials selects fallback; Google authorization and membership errors remain sanitized',async()=>{
  const client=createTesterGoogleGroup({env:{}});
  assert.equal(client.configured('client'),false);
  await assert.rejects(client.addMember('client','a@gmail.com'),/google_group_not_configured/);
  const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  const env={PLAY_TESTER_GOOGLE_CLIENT_EMAIL:'service@example.invalid',PLAY_TESTER_GOOGLE_ADMIN_EMAIL:'admin@example.invalid',
    PLAY_TESTER_GOOGLE_PRIVATE_KEY:privateKey.export({type:'pkcs8',format:'pem'}),PLAY_TESTER_GROUP_CLIENT:'testers@example.invalid'};
  const failed=createTesterGoogleGroup({env,fetchImpl:async()=>({ok:false,status:403})});
  await assert.rejects(failed.addMember('client','a@gmail.com'),/^Error: google_group_unavailable$/);
});
