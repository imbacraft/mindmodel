package shop;

import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class CatalogController {
    private final ItemRepo items;
    private final TagRepo tags;
    private final NoteRepo notes;

    public CatalogController(ItemRepo items, TagRepo tags, NoteRepo notes) {
        this.items = items;
        this.tags = tags;
        this.notes = notes;
    }

    @PostMapping("/items")
    public void create(Item item) {
        items.save(item);
        tags.save(new Tag());
        notes.save(new Note());
    }
}
