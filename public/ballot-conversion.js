(function exposeBallotConversion(global) {
	function orderedWineIdsFromNumeric(values, wineIds, tieOrder = wineIds) {
		const tiePositions = new Map(tieOrder.map((wineId, index) => [wineId, index]));
		const fallbackPosition = new Map(wineIds.map((wineId, index) => [wineId, index]));
		return [...wineIds].sort((left, right) => {
			const leftScore = values[left];
			const rightScore = values[right];
			const leftScored = Number.isFinite(leftScore);
			const rightScored = Number.isFinite(rightScore);
			if (leftScored !== rightScored) return leftScored ? -1 : 1;
			if (leftScored && leftScore !== rightScore) return rightScore - leftScore;
			return (tiePositions.get(left) ?? fallbackPosition.get(left)) - (tiePositions.get(right) ?? fallbackPosition.get(right));
		});
	}

	function proportionalScoresFromOrder(order, rankedCount, numericMax) {
		const count = Math.min(Math.max(0, rankedCount), order.length);
		const values = {};
		if (!count) return values;
		if (count === 1) {
			values[order[0]] = numericMax;
			return values;
		}
		for (let index = 0; index < count; index++) {
			values[order[index]] = Math.round(numericMax - (index * (numericMax - 1)) / (count - 1));
		}
		return values;
	}

	global.WineNightBallotConversion = Object.freeze({
		orderedWineIdsFromNumeric,
		proportionalScoresFromOrder,
	});
})(globalThis);
