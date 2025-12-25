const axios = require('axios');

async function getMinecraftProfileFromMsAccessToken(msAccessToken) {
  // 1) Get XBL token
  const xblResp = await axios.post('https://user.auth.xboxlive.com/user/authenticate', {
    Properties: {
      AuthMethod: 'RPS',
      SiteName: 'user.auth.xboxlive.com',
      RpsTicket: `d=${msAccessToken}`
    },
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType: 'JWT'
  }, { headers: { 'Content-Type': 'application/json' } });

  const xblToken = xblResp.data.Token;

  // 2) Get XSTS token
  const xstsResp = await axios.post('https://xsts.auth.xboxlive.com/xsts/authorize', {
    Properties: {
      SandboxId: 'RETAIL',
      UserTokens: [xblToken]
    },
    RelyingParty: 'rp://api.minecraftservices.com/',
    TokenType: 'JWT'
  }, { headers: { 'Content-Type': 'application/json' } });

  const xstsToken = xstsResp.data.Token;
  const uhs = xstsResp.data.DisplayClaims?.xui?.[0]?.uhs;
  if (!uhs) throw new Error('Missing UHS in XSTS response');

  // 3) Get Minecraft access token
  const mxResp = await axios.post('https://api.minecraftservices.com/authentication/login_with_xbox', {
    identityToken: `XBL3.0 x=${uhs};${xstsToken}`
  }, { headers: { 'Content-Type': 'application/json' } });

  const mcAccessToken = mxResp.data.access_token;

  // 4) Get profile
  const profileResp = await axios.get('https://api.minecraftservices.com/minecraft/profile', {
    headers: { Authorization: `Bearer ${mcAccessToken}` }
  });

  return profileResp.data; // { id, name, skins... }
}

module.exports = { getMinecraftProfileFromMsAccessToken };
