import { vec3, vec4, mat4, utils } from "pex-math";
import { aabb } from "pex-geom";
import createDescriptors from "./renderer/descriptors.js";

function drawMeshes({
  viewport,
  cameraEntity,
  shadowMapping,
  shadowMappingLight,
  entitiesInView,
  // forward, // TODO: is not used. remove?
  renderView: renderViewUpstream,
  renderers,
  drawTransparent,
  backgroundColorTexture,
  shadowQuality,
}) {
  // if (backgroundColorTexture) {
  //   ctx.update(backgroundColorTexture, { mipmap: true });
  // }

  //FIXME: code smell
  const renderView = renderViewUpstream || { viewport };

  //FIXME: code smell
  if (cameraEntity && !renderView.camera) {
    renderView.cameraEntity = cameraEntity;
    renderView.camera = cameraEntity.camera;
  }
  if (shadowMappingLight) {
    renderView.camera = {
      projectionMatrix: shadowMappingLight._projectionMatrix,
      viewMatrix: shadowMappingLight._viewMatrix,
    };
  }

  if (shadowMapping) {
    for (let i = 0; i < renderers.length; i++) {
      const renderer = renderers[i];
      if (renderer.renderStages.shadow) {
        renderer.renderStages.shadow(renderView, entitiesInView, {
          shadowMapping: true,
          shadowMappingLight,
        });
      }
    }
  } else {
    if (!drawTransparent) {
      for (let i = 0; i < renderers.length; i++) {
        const renderer = renderers[i];
        if (renderer.renderStages.opaque) {
          renderer.renderStages.opaque(renderView, entitiesInView, {
            shadowQuality,
          });
        }
      }
      for (let i = 0; i < renderers.length; i++) {
        const renderer = renderers[i];
        if (renderer.renderStages.background) {
          renderer.renderStages.background(renderView, entitiesInView, {
            shadowQuality,
          });
        }
      }
    } else {
      //TODO: capture color buffer and blur it for transmission/refraction
      for (let i = 0; i < renderers.length; i++) {
        const renderer = renderers[i];
        if (renderer.renderStages.transparent) {
          renderer.renderStages.transparent(renderView, entitiesInView, {
            backgroundColorTexture,
            shadowQuality,
          });
        }
      }
    }
  }
}

export default ({
  ctx,
  resourceCache,
  renderGraph,
  shadowQuality = 2,
  outputEncoding,
}) => ({
  type: "render-pipeline-system",
  cache: {},
  debug: true,
  shadowQuality,
  outputEncoding: outputEncoding || ctx.Encoding.Linear,
  renderers: [],
  descriptors: createDescriptors(ctx),
  drawMeshes,
  updateDirectionalLightShadowMap(
    lightEnt,
    entities,
    shadowCastingEntities,
    renderers
  ) {
    const light = lightEnt.directionalLight;
    // const position = lightEnt._transform.worldPosition;
    // const target = [0, 0, 1, 0];
    // const up = [0, 1, 0, 0];
    // vec4.multMat4(target, lightEnt._transform.modelMatrix);
    // vec3.add(target, position);
    // vec4.multMat4(up, lightEnt._transform.modelMatrix);
    // mat4.lookAt(light._viewMatrix, position, target, up);

    const shadowBboxPoints = shadowCastingEntities.reduce(
      (points, entity) =>
        points.concat(aabb.getCorners(entity.transform.worldBounds)),
      []
    );

    // TODO: gc vec3.copy, all the bounding box creation
    const bboxPointsInLightSpace = shadowBboxPoints.map((p) =>
      vec3.multMat4(vec3.copy(p), light._viewMatrix)
    );
    const sceneBboxInLightSpace = aabb.create();
    aabb.fromPoints(sceneBboxInLightSpace, bboxPointsInLightSpace);

    // console.log("sceneBboxInLightSpace", ...sceneBboxInLightSpace);

    const lightNear = -sceneBboxInLightSpace[1][2];
    const lightFar = -sceneBboxInLightSpace[0][2];

    light._near = lightNear;
    light._far = lightFar;

    mat4.ortho(
      light._projectionMatrix,
      sceneBboxInLightSpace[0][0],
      sceneBboxInLightSpace[1][0],
      sceneBboxInLightSpace[0][1],
      sceneBboxInLightSpace[1][1],
      lightNear,
      lightFar
    );

    light.sceneBboxInLightSpace = sceneBboxInLightSpace;

    let colorMapDesc = this.descriptors.directionalLightShadows.colorMapDesc;
    let shadowMapDesc = this.descriptors.directionalLightShadows.shadowMapDesc;

    // Only update descriptors for custom map size
    // TODO: could texture be cached if they have the same descriptor
    if (light.shadowMapSize) {
      colorMapDesc = {
        ...colorMapDesc,
        width: light.shadowMapSize,
        height: light.shadowMapSize,
      };
      shadowMapDesc = {
        ...shadowMapDesc,
        width: light.shadowMapSize,
        height: light.shadowMapSize,
      };
    }
    //TODO: can this be all done at once?
    let colorMap = resourceCache.texture2D(colorMapDesc);
    colorMap.name = "TempColorMap\n" + colorMap.id;

    let shadowMap = resourceCache.texture2D(shadowMapDesc);
    shadowMap.name = "ShadowMap\n" + shadowMap.id;

    //TODO: need to create new descriptor to get uniq
    let passDesc = { ...this.descriptors.directionalLightShadows.pass };
    passDesc.color = [colorMap];
    passDesc.depth = shadowMap;

    let shadowMapPass = resourceCache.pass(passDesc);

    const renderView = {
      camera: {
        viewMatrix: light._viewMatrix,
        projectionMatrix: light._projectionMatrix,
      },
      viewport: [0, 0, shadowMap.width, shadowMap.height],
    };

    renderGraph.renderPass({
      name: "RenderShadowMap" + lightEnt.id,
      pass: shadowMapPass,
      renderView: renderView,
      render: () => {
        // Needs to be here for multi-view with different renderer to not overwrite it
        light._shadowMap = shadowMap;

        drawMeshes({
          viewport: renderView.viewport,
          //TODO: passing camera entity around is a mess
          cameraEntity: {
            camera: {
              position: lightEnt._transform.worldPosition,
            },
          },
          shadowMapping: true,
          shadowMappingLight: light,
          entitiesInView: entities,
          renderableEntities: shadowCastingEntities,
          forward: false,
          drawTransparent: false,
          renderers,
        });
      },
    });

    light._shadowMap = shadowMap; // TODO: we borrow it for a frame
    // ctx.submit(shadowMapDrawCommand, () => {
    // drawMeshes(null, true, light, entities, shadowCastingEntities);
    // });
  },

  updateSpotLightShadowMap(
    lightEnt,
    entities,
    shadowCastingEntities,
    renderers
  ) {
    const light = lightEnt.spotLight;
    const position = lightEnt._transform.worldPosition;
    const target = [0, 0, 1, 0];
    const up = [0, 1, 0, 0];
    vec4.multMat4(target, lightEnt._transform.modelMatrix);
    vec4.multMat4(up, lightEnt._transform.modelMatrix);
    mat4.lookAt(light._viewMatrix, position, target, up);

    const shadowBboxPoints = shadowCastingEntities.reduce(
      (points, entity) =>
        points.concat(aabb.getCorners(entity.transform.worldBounds)),
      []
    );

    // TODO: gc vec3.copy, all the bounding box creation
    const bboxPointsInLightSpace = shadowBboxPoints.map((p) =>
      vec3.multMat4(vec3.copy(p), light._viewMatrix)
    );
    const sceneBboxInLightSpace = aabb.create();
    aabb.fromPoints(sceneBboxInLightSpace, bboxPointsInLightSpace);

    const lightNear = -sceneBboxInLightSpace[1][2];
    const lightFar = -sceneBboxInLightSpace[0][2];

    light._near = lightNear;
    light._far = lightFar;

    light.sceneBboxInLightSpace = sceneBboxInLightSpace;

    let colorMapDesc = this.descriptors.spotLightShadows.colorMapDesc;
    let shadowMapDesc = this.descriptors.spotLightShadows.shadowMapDesc;

    // Only update descriptors for custom map size
    // TODO: could texture be cached if they have the same descriptor
    if (light.shadowMapSize) {
      colorMapDesc = {
        ...colorMapDesc,
        width: light.shadowMapSize,
        height: light.shadowMapSize,
      };
      shadowMapDesc = {
        ...shadowMapDesc,
        width: light.shadowMapSize,
        height: light.shadowMapSize,
      };
    }

    //TODO: can this be all done at once?
    let colorMap = resourceCache.texture2D(colorMapDesc);
    colorMap.name = "TempColorMap\n" + colorMap.id;

    let shadowMap = resourceCache.texture2D(shadowMapDesc);
    shadowMap.name = "ShadowMap\n" + shadowMap.id;

    //TODO: need to create new descriptor to get uniq
    let passDesc = { ...this.descriptors.spotLightShadows.pass };
    passDesc.color = [colorMap];
    passDesc.depth = shadowMap;

    let shadowMapPass = resourceCache.pass(passDesc);

    mat4.perspective(
      light._projectionMatrix,
      2 * light.angle,
      shadowMap.width / shadowMap.height,
      lightNear,
      lightFar
    );

    const renderView = {
      camera: {
        viewMatrix: light._viewMatrix,
        projectionMatrix: light._projectionMatrix,
      },
      viewport: [0, 0, shadowMap.width, shadowMap.height],
    };

    renderGraph.renderPass({
      name: "RenderShadowMap" + lightEnt.id,
      pass: shadowMapPass,
      renderView: renderView,
      render: () => {
        light._shadowMap = shadowMap;
        drawMeshes({
          viewport: renderView.viewport,
          //TODO: passing camera entity around is a mess
          cameraEntity: {
            camera: {
              position: lightEnt._transform.worldPosition,
            },
          },
          shadowMapping: true,
          shadowMappingLight: light,
          entitiesInView: entities,
          renderableEntities: shadowCastingEntities,
          forward: false,
          drawTransparent: false,
          renderers,
        });
      },
    });

    light._shadowMap = shadowMap; // TODO: we borrow it for a frame
  },

  updatePointLightShadowMap(
    lightEnt,
    entities,
    shadowCastingEntities,
    renderers
  ) {
    const light = lightEnt.pointLight;

    let shadowCubemapDesc =
      this.descriptors.pointLightShadows.shadowCubemapDesc;
    let shadowMapDesc = this.descriptors.pointLightShadows.shadowMapDesc;

    // Only update descriptors for custom map size
    // TODO: could texture be cached if they have the same descriptor
    if (light.shadowMapSize) {
      shadowCubemapDesc = {
        ...shadowCubemapDesc,
        width: light.shadowMapSize,
        height: light.shadowMapSize,
      };
      shadowMapDesc = {
        ...shadowMapDesc,
        width: light.shadowMapSize,
        height: light.shadowMapSize,
      };
    }

    //TODO: can this be all done at once?
    let shadowCubemap = resourceCache.textureCube(shadowCubemapDesc);
    shadowCubemap.name = "TempCubemap\n" + shadowCubemap.id;

    let shadowMap = resourceCache.texture2D(shadowMapDesc);
    shadowMap.name = "ShadowMap\n" + shadowMap.id;

    this.descriptors.pointLightShadows.passes.forEach((pass, i) => {
      //TODO: need to create new descriptor to get uniq
      let passDesc = { ...pass };
      passDesc.color = [
        { texture: shadowCubemap, target: passDesc.color[0].target },
      ];
      passDesc.depth = shadowMap;

      let shadowMapPass = resourceCache.pass(passDesc);

      const side = this.descriptors.pointLightShadows.cubemapSides[i];
      const renderView = {
        camera: {
          projectionMatrix: side.projectionMatrix,
          viewMatrix: mat4.lookAt(
            mat4.create(),
            vec3.add([...side.eye], lightEnt._transform.worldPosition),
            vec3.add([...side.target], lightEnt._transform.worldPosition),
            side.up
          ),
        },
        viewport: [0, 0, shadowMap.width, shadowMap.height],
      };

      renderGraph.renderPass({
        name: "RenderShadowMap" + lightEnt.id,
        pass: shadowMapPass,
        renderView: renderView,
        render: () => {
          //why?
          light._shadowCubemap = shadowCubemap; // TODO: we borrow it for a frame
          light._projectionMatrix = side.projectionMatrix;
          light._viewMatrix = renderView.camera.viewMatrix;
          drawMeshes({
            viewport: renderView.viewport,
            renderView,
            //TODO: passing camera entity around is a mess
            // cameraEntity: {
            //   camera: {},
            // },
            shadowMapping: true,
            shadowMappingLight: light,
            entitiesInView: entities,
            renderableEntities: shadowCastingEntities,
            forward: false,
            drawTransparent: false,
            renderers,
          });
        },
      });
    });

    light._shadowCubemap = shadowCubemap; // TODO: we borrow it for a frame
    // ctx.submit(shadowMapDrawCommand, () => {
    // drawMeshes(null, true, light, entities, shadowCastingEntities);
    // });
  },

  patchDirectionalLight(directionalLight) {
    directionalLight._viewMatrix = mat4.create();
    directionalLight._projectionMatrix = mat4.create();
  },
  patchSpotLight(directionalLight) {
    directionalLight._viewMatrix = mat4.create();
    directionalLight._projectionMatrix = mat4.create();
  },

  update(entities, options = {}) {
    let { renderView, renderers, drawToScreen } = options;
    // ctx.submit(clearCmd);

    const rendererableEntities = entities.filter(
      (e) => e.geometry && e.material
    );

    const cameraEntities = entities.filter((e) => e.camera);
    const directionalLightEntities = entities.filter((e) => e.directionalLight);
    const pointLightEntities = entities.filter((e) => e.pointLight);
    const spotLightEntities = entities.filter((e) => e.spotLight);
    const shadowCastingEntities = rendererableEntities.filter(
      (e) => e.material.castShadows
    );

    if (!renderView) {
      renderView = {
        camera: cameraEntities[0].camera,
        viewport: [0, 0, ctx.gl.drawingBufferWidth, ctx.gl.drawingBufferHeight],
      };
    }

    directionalLightEntities.forEach((lightEntity) => {
      if (!lightEntity.directionalLight._viewMatrix) {
        this.patchDirectionalLight(lightEntity.directionalLight);
      }
      if (
        lightEntity.directionalLight.castShadows
        // FIXME: why this was here?
        // options.shadowPass !== false
      ) {
        // TODO: filtering lights which don't cast shadows
        this.updateDirectionalLightShadowMap(
          lightEntity,
          entities,
          shadowCastingEntities,
          renderers
        );
      }
    });

    pointLightEntities.forEach((lightEntity) => {
      if (lightEntity.pointLight.castShadows) {
        this.updatePointLightShadowMap(
          lightEntity,
          entities,
          shadowCastingEntities,
          renderers
        );
      }
    });

    spotLightEntities.forEach((lightEntity) => {
      if (!lightEntity.spotLight._viewMatrix) {
        this.patchSpotLight(lightEntity.spotLight);
      }
      if (lightEntity.spotLight.castShadows) {
        this.updateSpotLightShadowMap(
          lightEntity,
          entities,
          shadowCastingEntities,
          renderers
        );
      }
    });

    const shadowMaps = directionalLightEntities
      .map((e) => {
        return e.directionalLight._shadowMap;
      })
      .filter((_) => _);

    let entitiesInView = entities;
    let entitiesToDraw = rendererableEntities;

    if (renderView.camera.layer) {
      entitiesInView = entities.filter((e) => {
        return !e.layer || e.layer == renderView.camera.layer;
      });
      entitiesToDraw = rendererableEntities.filter((e) => {
        return !e.layer || e.layer == renderView.camera.layer;
      });
    }

    //TODO: this should be done on the fly by render graph
    this.descriptors.mainPass.outputTextureDesc.width = renderView.viewport[2];
    this.descriptors.mainPass.outputTextureDesc.height = renderView.viewport[3];
    const mainPassOutputTexture = resourceCache.texture2D(
      this.descriptors.mainPass.outputTextureDesc
    );
    mainPassOutputTexture.name = `mainPassOutput\n${mainPassOutputTexture.id}`;

    const mainPassNormalOutputTexture = resourceCache.texture2D(
      this.descriptors.mainPass.outputTextureDesc
    );
    mainPassNormalOutputTexture.name = `mainPassNormalOutput\n${mainPassNormalOutputTexture.id}`;

    this.descriptors.mainPass.outputDepthTextureDesc.width =
      renderView.viewport[2];
    this.descriptors.mainPass.outputDepthTextureDesc.height =
      renderView.viewport[3];
    const outputDepthTexture = resourceCache.texture2D(
      this.descriptors.mainPass.outputDepthTextureDesc
    );
    outputDepthTexture.name = `mainPassDepth\n${outputDepthTexture.id}`;

    const mainPass = resourceCache.pass({
      color: [mainPassOutputTexture, mainPassNormalOutputTexture],
      depth: outputDepthTexture,
      clearColor: renderView.camera.clearColor,
      clearDepth: 1,
    });
    renderGraph.renderPass({
      name: `MainPass ${renderView.viewport}`,
      uses: [...shadowMaps],
      renderView: {
        ...renderView,
        viewport: [0, 0, renderView.viewport[2], renderView.viewport[3]],
      },
      pass: mainPass,
      render: () => {
        drawMeshes({
          viewport: renderView.viewport,
          cameraEntity: renderView.cameraEntity,
          shadowMapping: false,
          entitiesInView: entitiesInView,
          renderableEntities: entitiesToDraw,
          forward: true,
          drawTransparent: false,
          renderers: renderers,
          shadowQuality: this.shadowQuality,
        });
      },
    });

    const needsGrabPass = !!entitiesInView.find(
      (e) => e.material?.transmission
    );
    let grabPassColorCopyTexture;
    if (needsGrabPass) {
      this.descriptors.grabPass.colorCopyTextureDesc.width =
        utils.prevPowerOfTwo(renderView.viewport[2]);
      this.descriptors.grabPass.colorCopyTextureDesc.height =
        utils.prevPowerOfTwo(renderView.viewport[3]);
      grabPassColorCopyTexture = resourceCache.texture2D(
        this.descriptors.grabPass.colorCopyTextureDesc
      );
      grabPassColorCopyTexture.name = `grapbPassOutput\n${grabPassColorCopyTexture.id}`;

      const grabPass = resourceCache.pass({
        color: [grabPassColorCopyTexture],
      });

      const copyTexturePipeline = resourceCache.pipeline(
        this.descriptors.grabPass.copyTexturePipelineDesc
      );
      const fullscreenTriangle = resourceCache.fullscreenTriangle();

      const copyTextureCmd = {
        name: "Copy Texture",
        attributes: fullscreenTriangle.attributes,
        count: fullscreenTriangle.count,
        pipeline: copyTexturePipeline,
        uniforms: {
          //uViewport: renderView.viewport,
          uViewport: [
            0,
            0,
            grabPassColorCopyTexture.width,
            grabPassColorCopyTexture.height,
          ],
          uTexture: mainPassOutputTexture,
        },
      };

      renderGraph.renderPass({
        name: `GrabPass ${renderView.viewport}`,
        uses: [mainPassOutputTexture],
        renderView: {
          ...renderView,
          //viewport: [0, 0, renderView.viewport[2], renderView.viewport[3]],
          viewport: [
            0,
            0,
            grabPassColorCopyTexture.width,
            grabPassColorCopyTexture.height,
          ],
        },
        pass: grabPass,
        render: () => {
          ctx.submit(copyTextureCmd);
        },
      });
    }
    // console.log("needsGrabPass", needsGrabPass);

    const transparentPass = resourceCache.pass({
      color: [mainPassOutputTexture],
      depth: outputDepthTexture,
    });
    renderGraph.renderPass({
      name: `TransparentMainPass ${renderView.viewport}`,
      uses: [...shadowMaps, grabPassColorCopyTexture].filter((_) => _), //filter out nulls
      renderView: {
        ...renderView,
        viewport: [0, 0, renderView.viewport[2], renderView.viewport[3]],
      },
      pass: transparentPass,
      render: () => {
        drawMeshes({
          viewport: renderView.viewport,
          cameraEntity: renderView.cameraEntity,
          shadowMapping: false,
          entitiesInView: entitiesInView,
          renderableEntities: entitiesToDraw,
          forward: true,
          drawTransparent: true,
          backgroundColorTexture: grabPassColorCopyTexture,
          renderers: renderers,
          shadowQuality: this.shadowQuality, //FIXME: that's a lot of passing down
        });
      },
    });

    if (drawToScreen !== false) {
      const postProcessingPipeline = resourceCache.pipeline(
        this.descriptors.tonemap.pipelineDesc
      );
      const fullscreenTriangle = resourceCache.fullscreenTriangle();

      const postProcessingCmd = {
        name: "Draw FSTriangle",
        attributes: fullscreenTriangle.attributes,
        count: fullscreenTriangle.count,
        pipeline: postProcessingPipeline,
        uniforms: {
          uViewport: renderView.viewport,
          uTexture: mainPassOutputTexture,
        },
      };
      renderGraph.renderPass({
        name: "PostProcessingPass",
        // pass: ctx.pass({ color: [{ id: -1 }] }),
        uses: [],
        renderView,
        render: () => {
          ctx.submit(postProcessingCmd);
        },
      });
    }

    return {
      color: mainPassOutputTexture,
      normal: mainPassNormalOutputTexture,
      depth: outputDepthTexture,
    };
  },
});
