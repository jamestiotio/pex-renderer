import { vec3, avec4, utils } from "pex-math";
import { parser as ShaderParser } from "pex-shaders";

import addDescriptors from "./descriptors.js";
import addShadowMapping from "./shadow-mapping.js";
import addPostProcessingPasses from "./post-processing-passes.js";

import { NAMESPACE, TEMP_VEC3, TEMP_VEC4 } from "../../utils.js";

function isEntityInFrustum(entity, frustum) {
  if (entity.geometry.culled !== false) {
    const worldBounds = entity.transform.worldBounds;
    for (let i = 0; i < 6; i++) {
      avec4.set(TEMP_VEC4, 0, frustum, i);
      TEMP_VEC3[0] = TEMP_VEC4[0] >= 0 ? worldBounds[1][0] : worldBounds[0][0];
      TEMP_VEC3[1] = TEMP_VEC4[1] >= 0 ? worldBounds[1][1] : worldBounds[0][1];
      TEMP_VEC3[2] = TEMP_VEC4[2] >= 0 ? worldBounds[1][2] : worldBounds[0][2];

      // Distance from plane to point
      if (vec3.dot(TEMP_VEC4, TEMP_VEC3) + TEMP_VEC4[3] < 0) return false;
    }
  }

  return true;
}

const cullEntities = (entities, camera) =>
  entities.filter(
    (entity) =>
      !entity.geometry ||
      (entity.transform && isEntityInFrustum(entity, camera.frustum))
  );

/**
 * Render pipeline system
 *
 * Adds:
 * - "_near", "_far", "_radiusUV" and "_sceneBboxInLightSpace" to light components that cast shadows
 * - "_shadowCubemap" to pointLight components and "_shadowMap" to other light components
 * - "_targets" to postProcessing components
 * @returns {import("../../types.js").System}
 */
export default ({ ctx, resourceCache, renderGraph }) => ({
  type: "render-pipeline-system",
  cache: {},
  debug: false,
  renderers: [],

  descriptors: addDescriptors(ctx),
  postProcessingPasses: null,
  shadowMapping: null,

  outputs: new Set(["color", "depth"]), // "normal", "emissive"

  checkLight(light, lightEntity) {
    if (!lightEntity._transform) {
      console.warn(
        NAMESPACE,
        `"${this.type}" light entity missing transform. Add a transformSystem.update(entities).`
      );
    } else if (!light._projectionMatrix) {
      console.warn(
        NAMESPACE,
        `"${this.type}" light component missing matrices. Add a lightSystem.update(entities).`
      );
    } else {
      return true;
    }
  },

  cullEntities,

  drawMeshes({
    renderView,
    shadowMapping,
    shadowMappingLight,
    entitiesInView,
    renderers,
    drawTransparent,
    backgroundColorTexture,
    outputs,
  }) {
    if (shadowMapping) {
      for (let i = 0; i < renderers.length; i++) {
        const renderer = renderers[i];
        if (renderer.renderStages.shadow) {
          renderer.renderStages.shadow(renderView, entitiesInView, {
            shadowMapping: true,
            shadowMappingLight,
            outputs,
          });
        }
      }
    } else {
      if (!drawTransparent) {
        for (let i = 0; i < renderers.length; i++) {
          const renderer = renderers[i];
          if (renderer.renderStages.opaque) {
            const entities = renderView.camera.culling
              ? this.cullEntities(entitiesInView, renderView.camera)
              : entitiesInView;
            renderer.renderStages.opaque(renderView, entities, { outputs });
          }
        }
        for (let i = 0; i < renderers.length; i++) {
          const renderer = renderers[i];
          if (renderer.renderStages.background) {
            renderer.renderStages.background(renderView, entitiesInView, {
              outputs,
            });
          }
        }
      } else {
        //TODO: capture color buffer and blur it for transmission/refraction
        for (let i = 0; i < renderers.length; i++) {
          const renderer = renderers[i];
          if (renderer.renderStages.transparent) {
            const entities = renderView.camera.culling
              ? this.cullEntities(entitiesInView, renderView.camera)
              : entitiesInView;
            renderer.renderStages.transparent(renderView, entities, {
              backgroundColorTexture,
              outputs,
            });
          }
        }
      }
    }
  },

  update(entities, options = {}) {
    let { renderView, renderers, drawToScreen } = options;

    const shadowCastingEntities = entities.filter(
      (entity) => entity.geometry && entity.material?.castShadows
    );
    const cameraEntities = entities.filter((entity) => entity.camera);

    renderView ||= {
      camera: cameraEntities[0].camera,
      viewport: [0, 0, ctx.gl.drawingBufferWidth, ctx.gl.drawingBufferHeight],
    };

    renderView.exposure ||=
      drawToScreen === false ? cameraEntities[0].camera.exposure : 1;
    renderView.outputEncoding ||=
      drawToScreen === false
        ? cameraEntities[0].camera.outputEncoding
        : ctx.Encoding.Linear;

    // Update shadow maps
    if (shadowCastingEntities.length) {
      this.shadowMapping ||= addShadowMapping({
        renderGraph,
        resourceCache,
        descriptors: this.descriptors,
        drawMeshes: this.drawMeshes,
      });

      for (let i = 0; i < entities.length; i++) {
        const entity = entities[i];

        if (
          entity.directionalLight?.castShadows &&
          this.checkLight(entity.directionalLight, entity)
        ) {
          this.shadowMapping.directionalLight(
            entity,
            entities,
            renderers,
            shadowCastingEntities
          );
        }
        if (
          entity.pointLight?.castShadows &&
          this.checkLight(entity.pointLight, entity)
        ) {
          this.shadowMapping.pointLight(entity, entities, renderers);
        }
        if (
          entity.spotLight?.castShadows &&
          this.checkLight(entity.spotLight, entity)
        ) {
          this.shadowMapping.spotLight(
            entity,
            entities,
            renderers,
            shadowCastingEntities
          );
        }
        if (
          entity.areaLight?.castShadows &&
          this.checkLight(entity.areaLight, entity)
        ) {
          this.shadowMapping.spotLight(
            entity,
            entities,
            renderers,
            shadowCastingEntities
          );
        }
      }
    }

    // TODO: this also get entities with shadowmap regardless of castShadows changes
    const shadowMaps = entities
      .map(
        (entity) =>
          entity.directionalLight?._shadowMap ||
          entity.spotLight?._shadowMap ||
          entity.areaLight?._shadowMap ||
          entity.pointLight?._shadowCubemap
      )
      .filter(Boolean);

    // Filter entities by layer
    const layer = renderView.camera.layer;
    const entitiesInView = layer
      ? entities.filter((entity) => !entity.layer || entity.layer === layer)
      : entities;

    // Setup attachments. Can be overwritten by PostProcessingPass
    const outputs = new Set(this.outputs);
    const postProcessing = renderView.cameraEntity.postProcessing;

    if (postProcessing?.ssao) outputs.add("normal");
    if (postProcessing?.bloom) outputs.add("emissive");

    const attachments = {};

    // TODO: this should be done on the fly by render graph
    this.descriptors.mainPass.outputTextureDesc.width = renderView.viewport[2];
    this.descriptors.mainPass.outputTextureDesc.height = renderView.viewport[3];

    attachments.color = resourceCache.texture2D(
      this.descriptors.mainPass.outputTextureDesc
    );
    attachments.color.name = `mainPassOutput (id: ${attachments.color.id})`;

    if (outputs.has("depth")) {
      this.descriptors.mainPass.outputDepthTextureDesc.width =
        renderView.viewport[2];
      this.descriptors.mainPass.outputDepthTextureDesc.height =
        renderView.viewport[3];
      attachments.depth = resourceCache.texture2D(
        this.descriptors.mainPass.outputDepthTextureDesc
      );
    }

    if (outputs.has("normal")) {
      attachments.normal = resourceCache.texture2D(
        this.descriptors.mainPass.outputTextureDesc
      );
    }

    if (outputs.has("emissive")) {
      attachments.emissive = resourceCache.texture2D(
        this.descriptors.mainPass.outputTextureDesc
      );
    }

    for (let name of Object.keys(attachments)) {
      const texture = attachments[name];
      texture.name = `mainPass${name} (id: ${texture.id})`;
    }

    const renderPassView = {
      ...renderView,
      viewport: [0, 0, renderView.viewport[2], renderView.viewport[3]],
    };

    // Main pass
    renderGraph.renderPass({
      name: `MainPass [${renderView.viewport}]`,
      uses: [...shadowMaps],
      renderView: renderPassView,
      pass: resourceCache.pass({
        name: "mainPass",
        color: [
          attachments.color,
          attachments.normal,
          attachments.emissive,
        ].filter(Boolean),
        depth: attachments.depth,
        clearColor: renderView.camera.clearColor,
        clearDepth: 1,
      }),
      render: () => {
        this.drawMeshes({
          renderView,
          shadowMapping: false,
          entitiesInView,
          drawTransparent: false,
          renderers,
          outputs,
        });
      },
    });

    // Grab pass
    let grabPassColorCopyTexture;
    if (entitiesInView.some((entity) => entity.material?.transmission)) {
      const viewport = [
        0,
        0,
        utils.prevPowerOfTwo(renderView.viewport[2]),
        utils.prevPowerOfTwo(renderView.viewport[3]),
      ];
      // const viewport = [0, 0, renderView.viewport[2], renderView.viewport[3]];
      this.descriptors.grabPass.colorCopyTextureDesc.width = viewport[2];
      this.descriptors.grabPass.colorCopyTextureDesc.height = viewport[3];
      grabPassColorCopyTexture = resourceCache.texture2D(
        this.descriptors.grabPass.colorCopyTextureDesc
      );
      grabPassColorCopyTexture.name = `grabPassOutput (id: ${grabPassColorCopyTexture.id})`;

      const fullscreenTriangle = resourceCache.fullscreenTriangle();

      const copyTextureCmd = {
        name: "grabPassCopyTextureCmd",
        attributes: fullscreenTriangle.attributes,
        count: fullscreenTriangle.count,
        pipeline: resourceCache.pipeline(
          this.descriptors.grabPass.copyTexturePipelineDesc
        ),
        uniforms: {
          uViewport: viewport,
          uTexture: attachments.color,
        },
      };

      renderGraph.renderPass({
        name: `GrabPass [${viewport}]`,
        uses: [attachments.color],
        renderView: { ...renderView, viewport },
        pass: resourceCache.pass({
          name: "grabPass",
          color: [grabPassColorCopyTexture],
        }),
        render: () => {
          ctx.submit(copyTextureCmd);
        },
      });
    }

    // Transparent pass
    renderGraph.renderPass({
      name: `TransparentPass [${renderView.viewport}]`,
      uses: [...shadowMaps, grabPassColorCopyTexture].filter(Boolean),
      renderView: renderPassView,
      pass: resourceCache.pass({
        name: "transparentPass",
        color: [attachments.color],
        depth: attachments.depth,
      }),
      render: () => {
        this.drawMeshes({
          renderView,
          shadowMapping: false,
          entitiesInView,
          drawTransparent: true,
          backgroundColorTexture: grabPassColorCopyTexture,
          renderers,
          outputs,
        });
      },
    });

    // Post-processing pass
    if (postProcessing) {
      this.postProcessingPasses ||= addPostProcessingPasses({
        ctx,
        resourceCache,
        descriptors: this.descriptors,
      });

      renderGraph.renderPass({
        name: `PostProcessingPass [${renderView.viewport}]`,
        uses: Object.values(attachments).filter(Boolean),
        renderView: renderPassView,
        render: () => {
          for (let i = 0; i < renderers.length; i++) {
            const renderer = renderers[i];
            renderer.renderStages.post?.(renderView, entitiesInView, {
              attachments,
              descriptors: this.descriptors,
              passes: this.postProcessingPasses,
            });
          }
        },
      });
    }

    if (drawToScreen !== false) {
      const fullscreenTriangle = resourceCache.fullscreenTriangle();

      // TODO: cache
      const pipelineDesc = { ...this.descriptors.blit.pipelineDesc };
      pipelineDesc.vert = ShaderParser.build(ctx, pipelineDesc.vert);
      pipelineDesc.frag = ShaderParser.build(
        ctx,
        pipelineDesc.frag,
        [
          !postProcessing &&
            renderView.camera.toneMap &&
            `TONEMAP ${renderView.camera.toneMap}`,
        ].filter(Boolean)
      );

      const blitCmd = {
        name: "drawBlitFullScreenTriangleCmd",
        attributes: fullscreenTriangle.attributes,
        count: fullscreenTriangle.count,
        pipeline: resourceCache.pipeline(pipelineDesc),
      };

      renderGraph.renderPass({
        name: `BlitPass [${renderView.viewport}]`,
        uses: [attachments.color],
        renderView,
        render: () => {
          ctx.submit(blitCmd, {
            uniforms: {
              // Post Processing already uses renderView.camera settings
              uExposure: postProcessing ? 1 : renderView.camera.exposure,
              uOutputEncoding: postProcessing
                ? ctx.Encoding.Linear
                : renderView.camera.outputEncoding,
              uTexture: attachments.color,
            },
          });
        },
      });
    }

    return attachments;
  },

  dispose(entities) {
    for (let i = 0; i < entities.length; i++) {
      const entity = entities[i];
      if (entity.material) {
        for (let property of Object.values(entity.material)) {
          if (
            property?.class === "texture" &&
            ctx.resources.indexOf(property) !== -1
          ) {
            ctx.dispose(property);
          }
        }
      }
    }
  },
});
