# Shadow mode

router.shadow(request) evaluates configured alternative policies and returns their decisions without sending a second provider request. It is useful for policy migrations, candidate catalog changes and offline comparisons.

Real shadow execution is not implemented. Setting executeShadowRequests=true throws explicitly. An application-owned execution harness must separately account for duplicated cost and privacy constraints.
