'use strict'

const express = require('express')
const moment = require('moment')

const router = express.Router()

const cache = require('../cache')
const {getTree, getMeta} = require('../list')
const {fetchDoc, cleanName, fetchByline} = require('../docs')
const {getTemplates} = require('../utils')

router.get('*', handleCategory)
module.exports = router

const categories = getTemplates('categories')
function handleCategory(req, res, next) {
  console.log(`GET ${req.path}`)
  const segments = req.path.split('/')

  // get an up to date doc tree
  getTree((err, tree) => {
    if (err) {
      return next(err)
    }

    const [data, parent] = retrieveDataForPath(req.path, tree)
    const {id, breadcrumb} = data
    if (!id) {
      return next(Error('Not found'))
    }

    const root = segments[1]
    const meta = getMeta(id)
    const layout = categories.has(root) ? root : 'default'
    const template = `categories/${layout}`

    // don't try to fetch branch node
    const contextData = prepareContextualData(data, req.path, breadcrumb, parent, meta.slug)
    const baseRenderData = Object.assign({}, contextData, {
      url: req.path,
      title: meta.prettyName,
      lastUpdatedBy: (meta.lastModifyingUser || {}).displayName,
      lastUpdated: meta.lastUpdated,
      createdAt: moment(meta.createdTime).fromNow(),
      editLink: meta.webViewLink
    })

    // if this is a folder, just render from the generic data
    const {resourceType} = meta
    if (resourceType === 'folder') {
      return res.render(template, baseRenderData, (err, html) => {
        if (err) return next(err)

        cache.add(id, meta.modifiedTime, req.path, html)
        res.end(html)
      })
    }

    // for docs, fetch the html and then combine with the base data
    fetchDoc({id, resourceType}, (err, {html, originalRevision, sections} = {}) => {
      if (err) {
        return next(err)
      }

      res.locals.docId = data.id

      const payload = fetchByline(html, originalRevision.lastModifyingUser.displayName)

      res.render(template, Object.assign({}, baseRenderData, {
        content: payload.html,
        byline: payload.byline,
        createdBy: originalRevision.lastModifyingUser.displayName,
        sections
      }), (err, html) => {
        if (err) return next(err)

        cache.add(id, meta.modifiedTime, req.path, html)
        res.end(html)
      })
    })
  })
}

function retrieveDataForPath(path, tree) {
  const segments = path.split('/').slice(1).filter((s) => s.length)

  let pointer = tree
  let parent = null
  // continue traversing down the tree while there are still segements to go
  while ((pointer || {}).nodeType === 'branch' && segments.length) {
    parent = pointer
    pointer = pointer.children[segments.shift()]
  }

  // if we are going to view a directory, switch to the home doc where possible
  if ((pointer || {}).nodeType === 'branch' && pointer.home) {
    pointer = Object.assign({}, pointer, {id: pointer.home, originalId: pointer.id})
  }

  // return the leaf and its immediate branch
  return [pointer || {}, parent]
}

function prepareContextualData(data, url, breadcrumb, parent, slug) {
  const breadcrumbInfo = breadcrumb.map(({id}) => getMeta(id))

  const {children: siblings, id} = parent
  const {children, originalId} = data
  const self = url.split('/').slice(-1)[0]
  // most of what we are doing here is preparing parents and siblings
  // we need the url and parent object, as well as the breadcrumb to do that
  const siblingLinks = createRelatedList(siblings, self, `${url.split('/').slice(0, -1).join('/')}`)
  const childrenLinks = createRelatedList(children || {}, self, url)

  // extend the breadcrumb with render data
  const parentLinks = url
    .split('/')
    .slice(1, -1) // ignore the base empty string and self
    .map((segment, i, arr) => {
      return {
        url: `/${arr.slice(0, i + 1).join('/')}`,
        name: cleanName(breadcrumbInfo[i].name),
        editLink: breadcrumbInfo[i].webViewLink
      }
    })

  return {
    parentId: originalId || id,
    parentLinks,
    siblings: siblingLinks,
    children: childrenLinks
  }
}

function createRelatedList(slugs, self, baseUrl) {
  return Object.keys(slugs)
    .filter((slug) => slug !== self)
    .map((slug) => {
      const {id, nodeType} = slugs[slug]
      const {sort, prettyName, webViewLink, path: url} = getMeta(id)
      return {
        sort,
        nodeType,
        name: prettyName,
        editLink: webViewLink,
        url
      }
    })
    .sort((a, b) => a.sort > b.sort)
}
