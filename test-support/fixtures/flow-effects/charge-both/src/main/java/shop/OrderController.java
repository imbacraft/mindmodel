package shop;

import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.client.RestTemplate;

@RestController
public class OrderController {
    private final ItemRepo items;
    private final RestTemplate restTemplate;

    public OrderController(ItemRepo items, RestTemplate restTemplate) {
        this.items = items;
        this.restTemplate = restTemplate;
    }

    @PostMapping("/items")
    public void create(Item item, boolean flag) {
        items.save(item);
        restTemplate.postForEntity("https://billing.example/charge", item, Void.class);
        if (flag) {
            restTemplate.postForEntity("https://billing.example/charge", item, Void.class);
        }
    }
}
