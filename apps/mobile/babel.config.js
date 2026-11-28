// Metro ve Jest (jest-expo) ayni Babel on ayarini kullanir.
module.exports = function (api) {
  api.cache(true);
  return { presets: ['babel-preset-expo'] };
};
