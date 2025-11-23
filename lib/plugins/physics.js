const { Vec3 } = require('vec3')
const assert = require('assert')
const math = require('../math')
const conv = require('../conversions')
const { performance } = require('perf_hooks')
const { createDoneTask, createTask } = require('../promise_utils')

const { Physics, PlayerState } = require('prismarine-physics')

module.exports = inject

const PI = Math.PI
const PI_2 = Math.PI * 2
const PHYSICS_INTERVAL_MS = 50
const PHYSICS_TIMESTEP = PHYSICS_INTERVAL_MS / 1000 // 0.05
const TOTAL_AREA = 0.8

function inject (bot, { physicsEnabled, maxCatchupTicks }) {
  const PHYSICS_CATCHUP_TICKS = maxCatchupTicks ?? 4
  const world = { getBlock: (pos) => { return bot.blockAt(pos, false) } }
  const physics = Physics(bot.registry, world)

  const positionUpdateSentEveryTick = bot.supportFeature('positionUpdateSentEveryTick')

  bot.jumpQueued = false
  bot.jumpTicks = 0 // autojump cooldown

  const controlState = {
    forward: false,
    back: false,
    left: false,
    right: false,
    jump: false,
    sprint: false,
    sneak: false
  }
  let lastSentYaw = null
  let lastSentPitch = null
  let lastRecordedYawPitch = [null, null]
  let doPhysicsTimer = null
  let lastPhysicsFrameTime = null
  let shouldUsePhysics = false
  bot.physicsEnabled = physicsEnabled ?? true
  let deadTicks = 21
  let yawSpeedOverride = null
  let pitchSpeedOverride = null
  let lookEasing = null // { startYaw, startPitch, targetYaw, targetPitch, sentTicks == 0, durationTicks }
  const lastSent = {
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    pitch: 0,
    onGround: false,
    time: 0,
    flags: { onGround: false, hasHorizontalCollision: false }
  }

  // This function should be executed each tick (every 0.05 seconds)
  // How it works: https://gafferongames.com/post/fix_your_timestep/

  // WARNING: THIS IS NOT ACCURATE ON WINDOWS (15.6 Timer Resolution)
  // use WSL or switch to Linux
  // see: https://discord.com/channels/413438066984747026/519952494768685086/901948718255833158
  let timeAccumulator = 0
  let catchupTicks = 0
  function doPhysics () {
    const now = performance.now()
    const deltaSeconds = (now - lastPhysicsFrameTime) / 1000
    lastPhysicsFrameTime = now

    timeAccumulator += deltaSeconds
    catchupTicks = 0
    while (timeAccumulator >= PHYSICS_TIMESTEP) {
      tickPhysics(now)
      timeAccumulator -= PHYSICS_TIMESTEP
      catchupTicks++
      if (catchupTicks >= PHYSICS_CATCHUP_TICKS) break
    }
  }

  function tickPhysics (now) {
    if (bot.blockAt(bot.entity.position) == null) return // check if chunk is unloaded
    if (bot.physicsEnabled && shouldUsePhysics) {
      physics.simulatePlayer(new PlayerState(bot, controlState), world).apply(bot)
      bot.emit('physicsTick')
      bot.emit('physicTick') // Deprecated, only exists to support old plugins. May be removed in the future
    }
    if (shouldUsePhysics) {
      updatePosition(now)
    }
  }

  // remove this when 'physicTick' is removed
  bot.on('newListener', (name) => {
    if (name === 'physicTick') console.warn('Mineflayer detected that you are using a deprecated event (physicTick)! Please use this event (physicsTick) instead.')
  })

  function cleanup () {
    clearInterval(doPhysicsTimer)
    doPhysicsTimer = null
  }

  function sendPacketPosition (position, onGround) {
    // sends data, no logic
    const oldPos = new Vec3(lastSent.x, lastSent.y, lastSent.z)
    lastSent.x = position.x
    lastSent.y = position.y
    lastSent.z = position.z
    lastSent.onGround = onGround
    lastSent.flags = { onGround, hasHorizontalCollision: undefined } // 1.21.3+
    bot._client.write('position', lastSent)
    bot.emit('move', oldPos)
  }

  function sendPacketLook (yaw, pitch, onGround) {
    // sends data, no logic
    const oldPos = new Vec3(lastSent.x, lastSent.y, lastSent.z)
    lastSent.yaw = yaw
    lastSent.pitch = pitch
    lastSent.onGround = onGround
    lastSent.flags = { onGround, hasHorizontalCollision: undefined } // 1.21.3+
    bot._client.write('look', lastSent)
    bot.emit('move', oldPos)
  }

  function sendPacketPositionAndLook (position, yaw, pitch, onGround) {
    // sends data, no logic
    const oldPos = new Vec3(lastSent.x, lastSent.y, lastSent.z)
    lastSent.x = position.x
    lastSent.y = position.y
    lastSent.z = position.z
    lastSent.yaw = yaw
    lastSent.pitch = pitch
    lastSent.onGround = onGround
    lastSent.flags = { onGround, hasHorizontalCollision: undefined } // 1.21.3+
    bot._client.write('position_look', lastSent)
    bot.emit('move', oldPos)
  }

  function deltaYaw (yaw1, yaw2) {
    let dYaw = (yaw1 - yaw2) % PI_2
    if (dYaw < -PI) dYaw += PI_2
    else if (dYaw > PI) dYaw -= PI_2

    return dYaw
  }

  // Trapezoid easing: ramps up in first 20%, constant middle 60%, ramps down last 20%
  // Speed ranges from 0.0 to 1.0 (0% to 100% of max speed)
  // Average speed multiplier (Total Area): 0.8
  // Returns the ratio of the current position to the target position (0.0 to 1.0) given time t (0.0 to 1.0)
  function trapezoidEasing(t) {

    if (t < 0.2) {
      // Ramp up: v(t) = 5t
      // Position integral: 2.5t²
      return (2.5 * t * t) / TOTAL_AREA;
    } else if (t < 0.8) {
      // Constant speed: v(t) = 1.0
      // Position integral: t - 0.1
      return (t - 0.1) / TOTAL_AREA;
    } else {
      // Ramp down: v(t) = 5 - 5t
      // Position integral: 5t - 2.5t² - 1.7
      return (5 * t - 2.5 * t * t - 1.7) / TOTAL_AREA;
    }
  }

  // returns false if bot should send position packets
  function isEntityRemoved () {
    if (bot.isAlive === true) deadTicks = 0
    if (bot.isAlive === false && deadTicks <= 20) deadTicks++
    if (deadTicks >= 20) return true
    return false
  }

  bot.getLastCameraAction = () => {
    if (lastRecordedYawPitch[0] === null || lastRecordedYawPitch[1] === null) {
      lastRecordedYawPitch = [lastSentYaw, lastSentPitch]
      return [0, 0]
    } else {
      const diff = [lastSentYaw - lastRecordedYawPitch[0], lastSentPitch - lastRecordedYawPitch[1]]
      lastRecordedYawPitch = [lastSentYaw, lastSentPitch]
      return diff
    }
  };

  bot.getLastPhysicsFrameTime = () => {
    return lastPhysicsFrameTime;
  };

  function updatePosition (now) {
    // Only send updates for 20 ticks after death
    if (isEntityRemoved()) return

    let dYaw = null
    let dPitch = null
    // If using easing, calculate position based on easing curve
    if (lookEasing) {
      const t = Math.min(lookEasing.sentTicks / lookEasing.durationTicks, 1.0)  
      const easedProgress = trapezoidEasing(t)
      lookEasing.sentTicks++

      // Calculate yaw delta (shortest path)
      const totalYawDelta = deltaYaw(lookEasing.targetYaw, lookEasing.startYaw)
      const totalPitchDelta = lookEasing.targetPitch - lookEasing.startPitch

      // Calculate delta to eased position
      dYaw = deltaYaw(lookEasing.startYaw + totalYawDelta * easedProgress, lastSentYaw)
      dPitch = (lookEasing.startPitch + totalPitchDelta * easedProgress) - (lastSentPitch || 0)
      if (lookEasing.sentTicks > lookEasing.durationTicks * 1.2) {
        console.warn('Look with easing still has not completed at t = ' + t + ' (>=1.2)!')
        console.warn('The target yaw is ' + lookEasing.targetYaw + ' and the start yaw is ' + lookEasing.startYaw, ' and the last sent yaw is ' + lastSentYaw)
        console.warn('The target pitch is ' + lookEasing.targetPitch + ' and the start pitch is ' + lookEasing.startPitch, ' and the last sent pitch is ' + lastSentPitch)
        console.warn('The lookEasing: ' + JSON.stringify(lookEasing))
      }
    } else {
      // Original linear interpolation logic
      // Increment the yaw in baby steps so that notchian clients (not the server) can keep up.
      dYaw = deltaYaw(bot.entity.yaw, lastSentYaw)
      dPitch = bot.entity.pitch - (lastSentPitch || 0)
    }

    // Vanilla doesn't clamp yaw, so we don't want to do it either
    const maxDeltaYaw = PHYSICS_TIMESTEP * (yawSpeedOverride ?? physics.yawSpeed)
    const maxDeltaPitch = PHYSICS_TIMESTEP * (pitchSpeedOverride ?? physics.pitchSpeed)
    lastSentYaw += math.clamp(-maxDeltaYaw, dYaw, maxDeltaYaw)
    lastSentPitch += math.clamp(-maxDeltaPitch, dPitch, maxDeltaPitch)

    const yaw = Math.fround(conv.toNotchianYaw(lastSentYaw))
    const pitch = Math.fround(conv.toNotchianPitch(lastSentPitch))
    const position = bot.entity.position
    const onGround = bot.entity.onGround

    // Only send a position update if necessary, select the appropriate packet
    const positionUpdated = lastSent.x !== position.x || lastSent.y !== position.y || lastSent.z !== position.z ||
      // Send a position update every second, even if no other update was made
      // This function rounds to the nearest 50ms (or PHYSICS_INTERVAL_MS) and checks if a second has passed.
      (Math.round((now - lastSent.time) / PHYSICS_INTERVAL_MS) * PHYSICS_INTERVAL_MS) >= 1000
    const lookUpdated = lastSent.yaw !== yaw || lastSent.pitch !== pitch

    if (positionUpdated && lookUpdated) {
      sendPacketPositionAndLook(position, yaw, pitch, onGround)
      lastSent.time = now // only reset if positionUpdated is true
    } else if (positionUpdated) {
      sendPacketPosition(position, onGround)
      lastSent.time = now // only reset if positionUpdated is true
    } else if (lookUpdated) {
      sendPacketLook(yaw, pitch, onGround)
    } else if (positionUpdateSentEveryTick || onGround !== lastSent.onGround) {
      // For versions < 1.12, one player packet should be sent every tick
      // for the server to update health correctly
      // For versions >= 1.12, onGround !== lastSent.onGround should be used, but it doesn't ever trigger outside of login
      bot._client.write('flying', {
        onGround: bot.entity.onGround,
        flags: { onGround: bot.entity.onGround, hasHorizontalCollision: undefined } // 1.21.3+
      })
    }

    lastSent.onGround = bot.entity.onGround // onGround is always set
  }

  bot.physics = physics

  function getEffectLevel (mcData, effectName, effects) {
    const effectDescriptor = mcData.effectsByName[effectName]
    if (!effectDescriptor) {
      return 0
    }
    const effectInfo = effects[effectDescriptor.id]
    if (!effectInfo) {
      return 0
    }
    return effectInfo.amplifier + 1
  }

  bot.elytraFly = async () => {
    if (bot.entity.elytraFlying) {
      throw new Error('Already elytra flying')
    } else if (bot.entity.onGround) {
      throw new Error('Unable to fly from ground')
    } else if (bot.entity.isInWater) {
      throw new Error('Unable to elytra fly while in water')
    }

    const mcData = require('minecraft-data')(bot.version)
    if (getEffectLevel(mcData, 'Levitation', bot.entity.effects) > 0) {
      throw new Error('Unable to elytra fly with levitation effect')
    }

    const torsoSlot = bot.getEquipmentDestSlot('torso')
    const item = bot.inventory.slots[torsoSlot]
    if (item == null || item.name !== 'elytra') {
      throw new Error('Elytra must be equip to start flying')
    }
    bot._client.write('entity_action', {
      entityId: bot.entity.id,
      actionId: bot.supportFeature('entityActionUsesStringMapper') ? 'start_elytra_flying' : 8,
      jumpBoost: 0
    })
  }

  bot.setControlState = (control, state) => {
    assert.ok(control in controlState, `invalid control: ${control}`)
    assert.ok(typeof state === 'boolean', `invalid state: ${state}`)
    if (controlState[control] === state) return
    controlState[control] = state
    if (control === 'jump' && state) {
      bot.jumpQueued = true
    } else if (control === 'sprint') {
      bot._client.write('entity_action', {
        entityId: bot.entity.id,
        actionId: bot.supportFeature('entityActionUsesStringMapper')
          ? (state ? 'start_sprinting' : 'stop_sprinting')
          : (state ? 3 : 4),
        jumpBoost: 0
      })
    } else if (control === 'sneak') {
      if (bot.supportFeature('newPlayerInputPacket')) {
        // In 1.21.6+, sneak is handled via player_input packet
        bot._client.write('player_input', {
          inputs: {
            shift: state
          }
        })
      } else {
        // Legacy entity_action approach for older versions
        bot._client.write('entity_action', {
          entityId: bot.entity.id,
          actionId: state ? 0 : 1,
          jumpBoost: 0
        })
      }
    }
  }

  bot.getControlState = (control) => {
    assert.ok(control in controlState, `invalid control: ${control}`)
    return controlState[control]
  }

  bot.clearControlStates = () => {
    for (const control in controlState) {
      bot.setControlState(control, false)
    }
  }

  bot.controlState = {}

  for (const control of Object.keys(controlState)) {
    Object.defineProperty(bot.controlState, control, {
      get () {
        return controlState[control]
      },
      set (state) {
        bot.setControlState(control, state)
        return state
      }
    })
  }

  let lookingTask = createDoneTask()

  bot.on('move', () => {
    if (!lookingTask.done && Math.abs(deltaYaw(bot.entity.yaw, lastSentYaw)) < 0.001) {
      lookingTask.finish()
      // Clear overrides when look task is complete
      yawSpeedOverride = null
      pitchSpeedOverride = null
      lookEasing = null
    }
  })

  bot._client.on('explosion', explosion => {
    // TODO: emit an explosion event with more info
    if (bot.physicsEnabled && bot.game.gameMode !== 'creative') {
      if (explosion.playerKnockback) { // 1.21.3+
        // Fixes issue #3635
        bot.entity.velocity.x += explosion.playerKnockback.x
        bot.entity.velocity.y += explosion.playerKnockback.y
        bot.entity.velocity.z += explosion.playerKnockback.z
      }
      if ('playerMotionX' in explosion) {
        bot.entity.velocity.x += explosion.playerMotionX
        bot.entity.velocity.y += explosion.playerMotionY
        bot.entity.velocity.z += explosion.playerMotionZ
      }
    }
  })

  bot.look = async (yaw, pitch, force, yawSpeedOverrideDPS, pitchSpeedOverrideDPS, useEasing = false) => {
    if (!lookingTask.done) {
      lookingTask.finish() // finish the previous one
      // Clean up state from previous look task
      yawSpeedOverride = null
      pitchSpeedOverride = null
      lookEasing = null
    }
    lookingTask = createTask()

    // convert from degrees/sec to radians/sec
    yawSpeedOverride = yawSpeedOverrideDPS != null ? yawSpeedOverrideDPS * Math.PI / 180 : null
    pitchSpeedOverride = pitchSpeedOverrideDPS != null ? pitchSpeedOverrideDPS * Math.PI / 180 : null

    // this is done to bypass certain anticheat checks that detect the player's sensitivity
    // by calculating the gcd of how much they move the mouse each tick
    const sensitivity = conv.fromNotchianPitch(0.15) // this is equal to 100% sensitivity in vanilla
    const yawChange = Math.round((yaw - bot.entity.yaw) / sensitivity) * sensitivity
    const pitchChange = Math.round((pitch - bot.entity.pitch) / sensitivity) * sensitivity

    if (yawChange === 0 && pitchChange === 0) {
      // Clear overrides and easing if no movement needed
      yawSpeedOverride = null
      pitchSpeedOverride = null
      lookEasing = null
      return
    }

    bot.entity.yaw += yawChange
    bot.entity.pitch += pitchChange

    if (force) {
      lastSentYaw = yaw
      lastSentPitch = pitch
      // Clear overrides when forcing position
      yawSpeedOverride = null
      pitchSpeedOverride = null
      lookEasing = null
      return
    }

    // Set up easing if requested
    if (useEasing) {
      const yawSpeed = yawSpeedOverride ?? physics.yawSpeed
      const pitchSpeed = pitchSpeedOverride ?? physics.pitchSpeed

      // Calculate duration in ticks based on trapezoid average speed (0.8) by rounding up
      const yawDurationTicks = Math.ceil(Math.abs(yawChange) / (yawSpeed * TOTAL_AREA) * 20)
      const pitchDurationTicks = Math.ceil(Math.abs(pitchChange) / (pitchSpeed * TOTAL_AREA) * 20)
      const durationTicks = Math.max(yawDurationTicks, pitchDurationTicks)

      lookEasing = {
        startYaw: lastSentYaw,
        startPitch: lastSentPitch,
        targetYaw: bot.entity.yaw,
        targetPitch: bot.entity.pitch,
        sentTicks: 0,
        durationTicks: durationTicks
      }
    } else {
      lookEasing = null
    }

    await lookingTask.promise
  }

  bot.lookAt = async (point, force, yawSpeedOverrideDPS, pitchSpeedOverrideDPS, useEasing = false) => {
    const delta = point.minus(bot.entity.position.offset(0, bot.entity.eyeHeight, 0))
    const yaw = Math.atan2(-delta.x, -delta.z)
    const groundDistance = Math.sqrt(delta.x * delta.x + delta.z * delta.z)
    const pitch = Math.atan2(delta.y, groundDistance)
    await bot.look(yaw, pitch, force, yawSpeedOverrideDPS, pitchSpeedOverrideDPS, useEasing)
  }

  // 1.21.3+
  bot._client.on('player_rotation', (packet) => {
    bot.entity.yaw = conv.fromNotchianYaw(packet.yaw)
    bot.entity.pitch = conv.fromNotchianPitch(packet.pitch)
  })

  // player position and look (clientbound)
  bot._client.on('position', (packet) => {
    // Is this necessary? Feels like it might wrongly overwrite hitbox size sometimes
    // e.g. when crouching/crawling/swimming. Can someone confirm?
    bot.entity.height = 1.8

    const vel = bot.entity.velocity
    const pos = bot.entity.position
    let newYaw, newPitch

    // Note: 1.20.5+ uses a bitflags object, older versions use a bitmask number
    if (typeof packet.flags === 'object') {
      // Modern path with bitflags object
      // Velocity is only set to 0 if the flag is not set, otherwise keep current velocity
      vel.set(
        packet.flags.x ? vel.x : 0,
        packet.flags.y ? vel.y : 0,
        packet.flags.z ? vel.z : 0
      )
      // If flag is set, then the corresponding value is relative, else it is absolute
      pos.set(
        packet.flags.x ? (pos.x + packet.x) : packet.x,
        packet.flags.y ? (pos.y + packet.y) : packet.y,
        packet.flags.z ? (pos.z + packet.z) : packet.z
      )
      newYaw = (packet.flags.yaw ? conv.toNotchianYaw(bot.entity.yaw) : 0) + packet.yaw
      newPitch = (packet.flags.pitch ? conv.toNotchianPitch(bot.entity.pitch) : 0) + packet.pitch
    } else {
      // Legacy path with bitmask number
      // Velocity is only set to 0 if the flag is not set, otherwise keep current velocity
      vel.set(
        packet.flags & 1 ? vel.x : 0,
        packet.flags & 2 ? vel.y : 0,
        packet.flags & 4 ? vel.z : 0
      )
      // If flag is set, then the corresponding value is relative, else it is absolute
      pos.set(
        packet.flags & 1 ? (pos.x + packet.x) : packet.x,
        packet.flags & 2 ? (pos.y + packet.y) : packet.y,
        packet.flags & 4 ? (pos.z + packet.z) : packet.z
      )
      newYaw = (packet.flags & 8 ? conv.toNotchianYaw(bot.entity.yaw) : 0) + packet.yaw
      newPitch = (packet.flags & 16 ? conv.toNotchianPitch(bot.entity.pitch) : 0) + packet.pitch
    }

    bot.entity.yaw = conv.fromNotchianYaw(newYaw)
    bot.entity.pitch = conv.fromNotchianPitch(newPitch)
    bot.entity.onGround = false

    if (bot.supportFeature('teleportUsesOwnPacket')) {
      bot._client.write('teleport_confirm', { teleportId: packet.teleportId })
    }
    sendPacketPositionAndLook(pos, newYaw, newPitch, bot.entity.onGround)

    shouldUsePhysics = true
    bot.jumpTicks = 0
    lastSentYaw = bot.entity.yaw
    lastSentPitch = bot.entity.pitch

    bot.emit('forcedMove')
  })

  bot.waitForTicks = async function (ticks) {
    if (ticks <= 0) return
    await new Promise(resolve => {
      const tickListener = () => {
        ticks--
        if (ticks === 0) {
          bot.removeListener('physicsTick', tickListener)
          resolve()
        }
      }

      bot.on('physicsTick', tickListener)
    })
  }

  bot.on('mount', () => { shouldUsePhysics = false })
  bot.on('respawn', () => { shouldUsePhysics = false })
  bot.on('login', () => {
    shouldUsePhysics = false
    if (doPhysicsTimer === null) {
      lastPhysicsFrameTime = performance.now()
      doPhysicsTimer = setInterval(doPhysics, PHYSICS_INTERVAL_MS)
    }
  })
  bot.on('end', cleanup)
}
