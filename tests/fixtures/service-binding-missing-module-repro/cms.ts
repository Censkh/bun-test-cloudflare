export default {
  async fetch() {
    const moduleName = "node_modules/payload/dist/uploads/isImage.js";
    const payloadModule = await import(moduleName);
    return new Response(payloadModule.isImage("image/png") ? "loaded" : "not-loaded");
  },
};
