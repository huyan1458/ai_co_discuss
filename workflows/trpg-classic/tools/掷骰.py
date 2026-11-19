"""Roll one fresh set of dice for a tabletop turn and print every face.

Takes no arguments, so members without a shell can run it as a registered command.
Output: two d20 (the second is for advantage or disadvantage) and four each of d4, d6, d8, d10, d12.
Use the faces left to right and quote the whole output in the turn.
"""
import secrets
import time

D20_COUNT = 2
OTHER_COUNT = 4
OTHER_SIDES = (4, 6, 8, 10, 12)


def roll(sides, count):
    """Return `count` uniformly random faces of a die with `sides` sides."""
    return [secrets.randbelow(sides) + 1 for _ in range(count)]


def main():
    """Print the dice set with a timestamp so each roll can be told apart."""
    lines = [time.strftime("掷骰时间 %Y-%m-%d %H:%M:%S"), f"d20: {roll(20, D20_COUNT)}"]
    lines += [f"d{sides}: {roll(sides, OTHER_COUNT)}" for sides in OTHER_SIDES]
    print("\n".join(lines))


if __name__ == "__main__":
    main()
