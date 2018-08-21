const createTransform = require('./transform')
const assert = require('assert')

let entityId = 0

function Entity (components, tags, renderer) {
  assert(!tags || Array.isArray(tags), 'Entity tags must be an array or null')
  this.id = entityId++
  this.tags = tags || []
  this.renderer = renderer

  this.components = components ? components.slice(0) : []

  this.transform = this.getComponent('Transform')
  if (!this.transform) {
    this.transform = createTransform({
      parent: null
    })
    this.components.unshift(this.transform)
  }

  this.components.forEach((component) => component.init(this))
}

Entity.prototype.dispose = function () {
  this.components.forEach((component) => {
    if (component.dispose) {
      component.dispose()
    }
  })
  // detach from the hierarchy
  this.transform.set({ parent: null })
}

Entity.prototype.addComponent = function (component) {
  this.components.push(component)
  component.init(this)
}

Entity.prototype.getComponent = function (type) {
  return this.components.find((component) => component.type === type)
}

module.exports = function createEntity (components, parent, tags) {
  return new Entity(components, parent, tags)
}
