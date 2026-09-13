// Synthetic admission fixtures. Mixed messages are policy tests, not observed mail.
const authenticationMessages = [
  {subject: 'Sign in to Acme', text: 'Your code is 123456'},
  {text: 'Acme: Your verification code is ABCDEF'},
  {subject: 'Acme', html: '<h1>Your verification code</h1><p>123456 expires in 10 minutes</p>'},
  {text: 'Acme: 123456 is your verification code.'},
  {text: 'Acme: Your verification code is aBcDeF'},
  {text: 'Acme: Your one-time passcode is 123456'},
  {text: 'Acme: Use 123456 to confirm your email'},
  {text: 'Acme: Here is your verification code: aBcDeF'},
  {text: 'Acme: Here is your one-time passcode: 123456'},
  {text: 'Acme: This is your security passcode: aBcDeF'},
  {text: 'Acme: Use coupon passcode SAVE20 to verify your account.'},
  {text: 'Acme: Your coupon verification code is 123456'},
  {text: 'Acme: Your discount security passcode is aBcDeF'},
  {text: 'Acme: verify your account using coupon code SAVE20.'},
  {text: 'Acme: 123456 is your verification code for signing in.'},
  {text: 'Acme: Enter 123456 to sign in.'},
  {subject: 'Your verification code', text: 'Hello Acme,\nYour code is 123456'},
  {text: 'Acme: Unlike the example above, your verification code is 123456.'},
  {text: 'Acme: Read the example above; your verification code is 123456.'},
  {text: 'Acme: Unlike the example below, your verification code is 123456.'},
  {text: 'Acme verification code below: LOGIN77'},
  {text: 'Acme verification code shown below: LOGIN77'},
  {text: 'Your verification code is 123456'},
  {text: 'An example uses no real code. Your verification code is 123456'},
  {text: 'Documentation is available in the help center.\nYour verification code is 123456'},
  {html: '<p>Documentation is available in the help center.</p><p>Your verification code is 123456</p>'},
  {text: 'Codice di verifica: 123456'},
  {text: 'Il tuo codice di verifica monouso è 123456'},
  {text: 'Security code: 123456'},
  {text: 'Your OTP is 123456'},
  {text: 'Acme: use code LOGIN77 to verify your order.'},
  {text: 'Acme: enter code LOGIN77 to reset your password.'},
  {text: 'Acme: use code LOGIN77 to sign in.'},
  {text: 'Acme: use code SAVE to verify your order.'},
  {text: 'Acme: use code LOGIN77 to verify your cart at checkout.'},
  {text: 'Acme: verify your account using code LOGIN77.'},
  {text: 'Brand: coupon code SAVE20 to reset your password for 20% off.'},
  {text: 'Brand: one-time code SAVE20 for your order.'},
  {text: 'Brand: codice di verifica SAVE20 per il tuo acquisto.'},
  {text: 'Brand: usa il codice SAVE20 per verificare il tuo account.'},
  {subject: 'Your verification code', text: '123456\nEnter this code to verify your account.'},
  {subject: 'Your verification code', text: 'Use code 123456 to verify your account.\nBrand coupon code SAVE20'},
  {html: '<h2>Your verification code</h2><p>Use code 123456 to verify your account.</p><p>Brand coupon code SAVE20</p>'},
  {subject: 'Account: codice di verifica monouso', text: 'Inserisci il codice di verifica entro 20 minuti.\nDEMO123.\nIl codice scadrà fra 20 minuti.'},
  {subject: 'Account: codice di verifica monouso', text: 'Notifica codice di verifica. Inserisci il codice di verifica entro 20 minuti. DEMO123. Nota: il codice scadrà 20 minuti dalla consegna.'},
  {html: '<h1>Your verification code</h1><div>123456</div><p>Enter it to verify your account.</p>'},
  {text: 'Il tuo codice di verifica\n123456\nInseriscilo per accedere.'},
  {text: 'Brand coupon code SAVE20. Your verification code is 123456'},
  {subject: 'Your verification code', html: '<p>123456</p><p>Brand coupon code SAVE20</p><img src="https://images.example/offer.png">'}
];

// Small synthetic cross-product of the R5 association dimensions. All consumers
// share these cases; no example here is represented as observed private mail.
for (const code of ['123456', 'ABCDEF', 'abcdef', 'aBcDeF', 'LOGIN77', 'ÈTÉ+20!']) {
  for (const locale of [
    {subject: 'Sign in to Acme', label: 'your verification code', generic: 'Your code is ',
      copula: ' is ', expiry: ' expires in 10 minutes'},
    {subject: 'Reimposta la password', label: 'il tuo codice di verifica', generic: 'Il tuo codice è ',
      copula: ' è ', expiry: ' scadrà fra 10 minuti'}
  ]) {
    for (const continuation of ['', locale.expiry]) {
      authenticationMessages.push(
        {subject: locale.subject, text: locale.generic + code + continuation},
        {text: 'Acme: ' + locale.label + locale.copula + code + continuation},
        {text: 'Acme: ' + code + locale.copula + locale.label + continuation + '.'},
        {subject: locale.subject, text: locale.generic.trimEnd() + ': ' + code + continuation},
        {subject: locale.label, text: code + continuation},
        {html: '<h1>' + locale.label + '</h1><p>' + code + continuation + '</p>'}
      );
    }
  }
}
authenticationMessages.push(
  {text: '123456 is your verification code, valid for 10 minutes.'},
  {text: 'ABCDEF is your verification code and expires in 10 minutes.'},
  {subject: 'Sign in to Acme', text: '123456 is your code.'},
  {subject: 'Reimposta la password', text: 'ABCDEF è il tuo codice.'}
);
for (const label of ['code', 'passcode', 'coupon code', 'promo code', 'discount code', 'codice', 'codice sconto']) {
  authenticationMessages.push(
    {text: 'Acme: verify your account using ' + label + ' LOGIN77.'},
    {text: 'Acme: sign into your account with ' + label + ' LOGIN77.'},
    {text: 'Acme: use ' + label + ' LOGIN77 to sign in.'}
  );
}
for (const [verb, purpose] of [['Enter', 'to sign in'], ['Use', 'for verifying your account'], ['Inserisci', 'per accedere']]) {
  authenticationMessages.push({text: 'Acme: ' + verb + ' ABCDEF ' + purpose + '.'});
}
for (const code of ['123456', 'aBcDeF']) {
  authenticationMessages.push(
    {text: 'Acme: Your security passcode is ' + code},
    {text: 'Acme: ' + code + ' is your one-time passcode.'},
    {subject: 'Your one-time passcode', text: 'Hello Acme,\nYour code is ' + code},
    {text: 'Acme: usa ' + code + ' per confermare la tua email.'},
    {text: 'Acme: Confirm your account using code ' + code}
  );
}

const ordinaryMessages = [
  {text: 'Brand: discount passcode SAVE20. Brand coupon code SAVE20'},
  {text: 'Brand: coupon passcode SAVE20 for your order. Brand coupon code SAVE20'},
  {text: 'Your verification code is ready. Brand coupon code SAVE20'},
  {text: 'Your verification code is pending. Brand coupon code SAVE20'},
  {text: 'Verification code 2FA! is only described in our documentation. Brand coupon code SAVE20'},
  {text: 'Verification code 2FA. is merely discussed in our documentation. Brand coupon code SAVE20'},
  {text: 'Verification code 2FA is described in our documentation. Brand coupon code SAVE20'},
  {text: 'Verification code 2FA! is described in our documentation. Brand coupon code SAVE20'},
  {text: 'Verification code 2FA. is described in our documentation. Brand coupon code SAVE20'},
  {text: 'Your verification code is available. Brand coupon code SAVE20'},
  {text: 'Your verification code is sent separately. Brand coupon code SAVE20'},
  {text: 'Your verification code is Required. Brand coupon code SAVE20'},
  {text: 'Your verification code is Sent separately. Brand coupon code SAVE20'},
  {text: 'Brand: use SAVE20 to confirm your order with 20% off.'},
  {text: 'Brand: usa SAVE20 per confermare il tuo ordine.'},
  {text: 'To troubleshoot, read the example below; your verification code is 123456. Brand coupon code SAVE20'},
  {text: 'See the example below, your verification code is 123456. Brand coupon code SAVE20'},
  {text: 'Consult the example below; your verification code is 123456. Brand coupon code SAVE20'},
  {text: 'Troubleshoot your verification code: https://help.acme.example/article/12345. Brand coupon code SAVE20'},
  {text: 'Troubleshoot your verification code: help123@acme.example. Brand coupon code SAVE20'},
  {text: 'For example, your verification code is 123456. Brand coupon code SAVE20'},
  {text: 'Example; your verification code is 123456. Brand coupon code SAVE20'},
  {text: 'Brand: use SAVE20 to save on your order.'},
  {text: 'Brand: log in and redeem coupon code SAVE20 at checkout.'},
  {text: 'Brand: After login, get 20% off using coupon code SAVE20'},
  {subject: 'Your verification code', text: 'Hello Acme,\n123456 orders used coupon code SAVE20'},
  {subject: 'Your verification code', text: 'Hello Acme,\nBrand coupon code SAVE20'},
  {subject: 'Sign in to save', text: 'Your code is SAVE20'},
  {text: 'Your verification code is SENT separately. Brand coupon code SAVE20'},
  {text: 'Your verification code is ABCDEF (example). Brand coupon code SAVE20'},
  {text: 'ABCDEF is your verification code (example). Brand coupon code SAVE20'},
  {html: '<h1>Your verification code</h1><p>ABCDEF (example)</p><p>Brand coupon code SAVE20</p>'},
  {subject: 'Sign in to Acme', text: 'Brand: use code SAVE20 to get 20% off'},
  {subject: 'Sign in to Acme', text: 'Example: Your code is 123456. Brand coupon code SAVE20'},
  {subject: 'Login for discounts', text: 'Brand: Your code is SAVE20 for 20% off'},
  {subject: 'Sign in to Acme for discounts', text: 'Brand: Your code is SAVE20'},
  {subject: 'Sign in to Acme', text: 'Brand: coupon code is SAVE20'},
  {text: 'Example: ABCDEF is your verification code. Brand coupon code SAVE20'},
  {html: '<h1>Your verification code</h1><p>is required before checkout.</p><p>123456 orders use Brand coupon code SAVE20</p>'},
  {subject: 'Sign in to Acme', html: '<h2>Example</h2><p>Your code is ABCDEF</p><p>Brand coupon code SAVE20</p>'},
  {text: 'REQUIRED is your verification code status. Brand coupon code SAVE20'},
  {html: '<h1>Your verification code</h1><p>REQUIRED before checkout</p><p>Brand coupon code SAVE20</p>'},
  {text: 'Brand: Log in to your account and use code SAVE20 to get 20% off'},
  {text: 'Brand: verification code is required before checkout. Coupon code SAVE20'},
  {text: 'Your verification code is REQUIRED before checkout. Coupon code SAVE20'},
  {text: 'Your verification code is REQUIRED. Coupon code SAVE20'},
  {text: 'Your verification code is REQUIRED to verify your account. Brand coupon code SAVE20'},
  {text: 'Il codice di verifica è NECESSARIO per verificare il tuo account. Brand coupon code SAVE20'},
  {text: 'Your verification code\nis required before checkout.\nCoupon code\nSAVE20'},
  {html: '<h1>Your verification code</h1><p>is required before checkout.</p><p>Coupon code</p><p>SAVE20</p>'},
  {subject: 'Example: Your verification code', text: '123456\nBrand coupon code SAVE20'},
  {subject: 'Example: Your verification code', text: 'Use code 123456 to verify your account.\nBrand coupon code SAVE20'},
  {html: '<h2>Example: Your verification code</h2><p>Use code 123456 to verify your account.</p><p>Brand coupon code SAVE20</p>'},
  {text: 'Documentation example:\nYour verification code\n123456\nCoupon code SAVE20'},
  {html: '<h1>Documentation example</h1><h2>Your verification code</h2><pre>123456</pre><p>Coupon code SAVE20</p>'},
  {text: 'Brand: your verification code expires shortly. Coupon code SAVE20'},
  {text: 'Brand: il codice di verifica scadrà. Codice sconto SAVE20'},
  {text: 'Brand: example verification code: 123456. Coupon code SAVE20'},
  {text: 'Brand: codice di verifica di esempio: 123456. Codice sconto SAVE20'},
  {text: 'Brand: Your verification code is CODE_HERE. Coupon code SAVE20'},
  {text: 'Brand: OTP documentation for your account. Coupon code SAVE20'},
  {text: 'Brand: coupon code SAVE20 after login.'},
  {text: 'Brand: log in and apply code SAVE20 at checkout.'},
  {text: 'Brand: 20% off with code SAVE20 after login.'},
  {text: 'Brand promo: usa il codice SAVE20 dopo accesso.'},
  {subject: 'Your account', text: 'Brand coupon code SAVE20'},
  {sender: 'Your verification code: 123456', text: 'Brand coupon code SAVE20'},
  {html: '<!-- Your verification code: 123456 --><p>Brand coupon code SAVE20</p>'},
  {html: '<div hidden>Your verification code: 123456</div><p>Brand coupon code SAVE20</p>'}
];
// Cross-boundary roles, not just the reported spellings: same literal/label
// presented as actual issuance, an example, descriptive prose or a locator.
for (const noun of ['code', 'passcode']) {
  for (const code of ['123456', 'ABCDEF', 'abcdef', 'aBcDeF', 'MiXeD77']) {
    authenticationMessages.push(
      {subject: 'Your verification ' + noun, text: 'Hello Acme,\nYour ' + noun + ' is ' + code},
      {html: '<h1>Your verification ' + noun + '</h1><p>' + code + '</p>'},
      {text: 'Acme: use ' + noun + ' ' + code + ' to confirm your email.'},
      {subject: 'Confirm your email', text: 'Acme: ' + code + ' is your ' + noun + '.'}
    );
    ordinaryMessages.push(
      {text: 'For example, your verification ' + noun + ' is ' + code + '. Brand coupon code SAVE20'},
      {html: '<h1>Example: Your verification ' + noun + '</h1><p>' + code + '</p><p>Brand coupon code SAVE20</p>'}
    );
  }
  for (const value of ['2FA', '2FA!', '2FA.', 'Mechanism', 'https://help.example/123', 'help123@example.com']) {
    ordinaryMessages.push({text: 'Verification ' + noun + ' ' + value + ' is described in our documentation. Brand coupon code SAVE20'});
  }
}
module.exports = {authenticationMessages, ordinaryMessages};
