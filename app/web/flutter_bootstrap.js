{{flutter_js}}
{{flutter_build_config}}

// index.html shows the app's icon while the app loads. It goes once the app is running and has drawn over it.
_flutter.loader.load({
  onEntrypointLoaded: async function (engineInitializer) {
    const appRunner = await engineInitializer.initializeEngine();
    await appRunner.runApp();
    document.getElementById('loading')?.remove();
  },
});
