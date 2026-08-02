# Shadow mode

router.shadow(request) evaluates configured alternative policies and returns their decisions without sending a second provider request. It is useful for policy migrations, candidate catalog changes and offline comparisons.

Real shadow execution is not part of the default flow. If an application adds it, it must explicitly enable executeShadowRequests, estimate duplicated cost and review privacy implications.
