package gen.mapper;

import app.Order;
import app.OrderDto;
import app.OrderMapper;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Supplier;

/**
 * Written by an annotation processor: a body per mapping method, every line a call. Nothing here is the project's code,
 * so the dump writes no row for it — its signatures only exist so that `app.GeneratedUse` resolves.
 */
public class OrderMapperImpl implements OrderMapper {

    @Override
    public OrderDto toDto(Order order) {
        if (order == null) return null;
        OrderDto dto = new OrderDto();
        dto.setId(order.getId());
        dto.setName(order.getName().trim());
        dto.setTotal(order.getTotal());
        if (dto.getName().isEmpty()) throw new IllegalStateException("an unnamed order");
        return dto;
    }

    @Override
    public List<OrderDto> all(List<Order> orders) {
        List<OrderDto> out = new ArrayList<>();
        for (Order order : orders) out.add(toDto(order));
        return out;
    }

    public static OrderMapperImpl instance() {
        return new OrderMapperImpl();
    }

    public Supplier<OrderDto> lazy(Order order) {
        return () -> {
            OrderDto dto = toDto(order);
            dto.setName(dto.getName() + "!");
            return dto;
        };
    }

    public Runnable hook() {
        return new Runnable() {
            @Override
            public void run() {
                System.out.println("hook");
            }
        };
    }
}
